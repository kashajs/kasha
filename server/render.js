const { URL } = require('url')
const assert = require('assert')
const { extname } = require('path')
const request = require('request')
const { addToQueue, replyTo } = require('./workerResponse')
const reply = require('./reply')
const RESTError = require('../shared/RESTError')
const logger = require('../shared/logger')
const { db } = require('../shared/mongo')
const { writer: nsqWriter } = require('../shared/nsqWriter')
const uid = require('../shared/uid')
const callback = require('../shared/callback')
const poll = require('../shared/poll')
const normalizeDoc = require('../shared/normalizeDoc')
const urlRewrite = require('../shared/urlRewrite')

async function render(ctx) {
  const now = Date.now()
  const { deviceType = 'desktop', callbackURL } = ctx.query
  let { url, type = 'html', noWait, metaOnly, followRedirect, refresh } = ctx.query

  try {
    url = new URL(url)
    assert(['http:', 'https:'].includes(url.protocol))
  } catch (e) {
    throw new RESTError('CLIENT_INVALID_PARAM', 'url')
  }

  if (!['mobile', 'desktop'].includes(deviceType)) {
    throw new RESTError('CLIENT_INVALID_PARAM', 'deviceType')
  }

  if (callbackURL) {
    try {
      assert(['http:', 'https:'].includes(new URL(callbackURL).protocol))
    } catch (e) {
      throw new RESTError('CLIENT_INVALID_PARAM', 'callbackURL')
    }
  }

  const validValues = [undefined, '', '0', '1']
  const truthyValues = ['', '1']

  if (!['html', 'static', 'json'].includes(type)) {
    throw new RESTError('CLIENT_INVALID_PARAM', 'type')
  }

  if (!validValues.includes(noWait)) {
    throw new RESTError('CLIENT_INVALID_PARAM', 'noWait')
  } else {
    noWait = truthyValues.includes(noWait)
  }

  if (!validValues.includes(metaOnly)) {
    throw new RESTError('CLIENT_INVALID_PARAM', 'metaOnly')
  } else {
    metaOnly = truthyValues.includes(metaOnly)
  }

  if (!validValues.includes(followRedirect)) {
    throw new RESTError('CLIENT_INVALID_PARAM', 'followRedirect')
  } else {
    followRedirect = truthyValues.includes(followRedirect)
  }

  if (!validValues.includes(refresh)) {
    throw new RESTError('CLIENT_INVALID_PARAM', 'refresh')
  } else {
    refresh = truthyValues.includes(refresh)
  }

  if ((callbackURL || metaOnly) && type !== 'json') {
    type = 'json'
  }

  if (noWait && (callbackURL || metaOnly || ctx.query.type)) {
    throw new RESTError(
      'CLIENT_INVALID_PARAM',
      'noWait can\'t be used with callbackURL | metaOnly | type'
    )
  }

  const site = url.origin
  let path = url.pathname

  if (noWait || callbackURL) {
    ctx.body = { queued: true }

    // don't let handler() block the request
    handler().catch(e => {
      if (callbackURL) callback(callbackURL, e)
    })
  } else {
    return handler()
  }

  async function handler() {
    if (!ctx.siteConfig) {
      try {
        ctx.siteConfig = await db.collection('sites').findOne({ host: url.host })
      } catch (e) {
        const { timestamp, eventId } = logger.error(e)
        throw new RESTError('SERVER_INTERNAL_ERROR', timestamp, eventId)
      }
    }

    if (!ctx.siteConfig || !ctx.siteConfig.removeQueryString) {
      path += url.search
    }

    if (!ctx.siteConfig || !ctx.siteConfig.removeHash) {
      path += url.hash
    }

    logger.debug(ctx.url, {
      extra: {
        params: { site, path, deviceType, callbackURL, type, noWait, metaOnly, followRedirect }
      }
    })

    if (ctx.siteConfig && ctx.siteConfig.assetExtensions) {
      const ext = extname(url.pathname)
      const isAsset = ctx.siteConfig.assetExtensions.includes(ext)
      if (isAsset) {
        if (ctx.mode === 'proxy') {
          if (ctx.siteConfig.rewrites) {
            url.href = urlRewrite(url.href, ctx.siteConfig.rewrites)
          }
          ctx.body = request(url.href)
          return
        } else {
          throw new RESTError('CLIENT_NOT_HTML', url.href)
        }
      }
    }

    let doc

    try {
      doc = await db.collection('snapshots').findOne({ site, path, deviceType })
    } catch (e) {
      const { timestamp, eventId } = logger.error(e)
      throw new RESTError('SERVER_INTERNAL_ERROR', timestamp, eventId)
    }

    if (!doc) {
      return sendToWorker(refresh ? 'BYPASS' : 'MISS')
    }

    const { privateExpires, sharedExpires, lock } = doc

    if (refresh) {
      if (!lock) {
        return sendToWorker('BYPASS')
      }
    } else {
      if (privateExpires && privateExpires >= now) {
        return handleResult(doc, 'HIT')
      }

      if (sharedExpires && sharedExpires >= now) {
        // refresh cache in background
        if (!lock) {
          sendToWorker(null, { noWait: true, callbackURL: null })
        }

        return handleResult(doc, doc.error ? 'STALE' : 'UPDATING')
      }
    }

    if (lock) {
      try {
        doc = await poll(site, path, deviceType, lock)
        return handleResult(doc, refresh ? 'BYPASS' : privateExpires ? 'EXPIRED' : 'MISS')
      } catch (e) {
        // something went wrong when updating the document.
        // we still use the stale doc if available.
        // but don't give cache response if 'refresh' param is set.
        if (doc.status || !refresh) {
          return handleResult(doc, privateExpires && privateExpires >= now ? 'HIT' : 'STALE')
        } else {
          throw e
        }
      }
    }

    return sendToWorker('EXPIRED')
  }

  function handleResult(doc, cacheStatus) {
    if (doc.status) {
      doc = normalizeDoc(doc, metaOnly)

      if (callbackURL) {
        callback(callbackURL, null, doc, cacheStatus)
      } else if (!noWait) {
        reply(ctx, type, followRedirect, doc, cacheStatus)
      }
    } else {
      throw new RESTError(doc.error)
    }
  }

  function sendToWorker(cacheStatus, options = {}) {
    options = { noWait, callbackURL, ...options }

    return new Promise((resolve, reject) => {
      const msg = {
        site,
        path,
        deviceType,
        rewrites: ctx.siteConfig && ctx.siteConfig.rewrites
          ? ctx.siteConfig.rewrites.map(
            ([search, replace]) =>
              search.constructor === RegExp ? ['regexp', search.toString(), replace] : ['string', search, replace]
          ) : null,
        callbackURL: options.callbackURL,
        metaOnly,
        cacheStatus
      }

      let topic
      if (options.callbackURL || options.noWait) {
        topic = 'kasha-async-queue'
      } else {
        topic = 'kasha-sync-queue'
        msg.replyTo = replyTo
        msg.correlationId = uid()
      }

      nsqWriter.publish(topic, msg, e => {
        if (e) {
          const { timestamp, eventId } = logger.error(e)
          reject(new RESTError('SERVER_INTERNAL_ERROR', timestamp, eventId))
        } else {
          if (options.callbackURL || options.noWait) {
            resolve()
          } else {
            resolve(addToQueue({
              correlationId: msg.correlationId,
              ctx,
              type,
              followRedirect
            }))
          }
        }
      })
    })
  }
}

module.exports = render
