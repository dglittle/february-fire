
var Fiber = require('fibers')

_.md5 = function (s) {
    return require('crypto').createHash('md5').update(s).digest("hex")    
}

_.run = function (f) {
    var c = Fiber.current
    if (c) c.yielding = true
    if (typeof(f) == 'function')
        var ret = Fiber(f).run()
    else
        if (f != c && f.started && !f.yielding)
            var ret = f.run()
    if (c) c.yielding = false
    return ret
}

_.yield = function () {
    return Fiber.yield()
}

_.promise = function () {
    var f = Fiber.current
    var done = false
    var val = null
    return {
        set : function (v) {
            done = true
            val = v
            _.run(f)
        },
        get : function () {
            while (!done) _.yield()
            done = false
            return val
        }
    }
}

_.consume = function (input, encoding) {
    if (encoding == 'buffer') {
        var buffer = new Buffer(1 * input.headers['content-length'])
        var cursor = 0
    } else {
        var chunks = []
        input.setEncoding(encoding || 'utf8')
    }
    
    var p = _.promise()
    input.on('data', function (chunk) {
        if (encoding == 'buffer') {
            chunk.copy(buffer, cursor)
            cursor += chunk.length
        } else {
            chunks.push(chunk)
        }
    })
    input.on('end', function () {
        if (encoding == 'buffer') {
            p.set(buffer)
        } else {
            p.set(chunks.join(''))
        }
    })
    return p.get()
}

_.wget = function (url, params, encoding) {
    url = require('url').parse(url)
    
    var o = {
        method : params ? 'POST' : 'GET',
        hostname : url.hostname,
        path : url.path
    }
    if (url.port)
        o.port = url.port
    
    var data = ""
    var dataEnc = null
    if (params && params.length != null) {
        data = params
        o.headers = {
            "Content-Length" : data.length
        }
    } else {
        data = _.values(_.map(params, function (v, k) { return k + "=" + encodeURIComponent(v) })).join('&')
        
        o.headers = {
            "Content-Type" : "application/x-www-form-urlencoded",
            "Content-Length" : Buffer.byteLength(data, 'utf8')
        }
        
        dataEnc = "utf8"
    }
    
    var p = _.promise()
    var req = require(url.protocol.replace(/:/, '')).request(o, function (res) {
        _.run(function () {
            p.set(_.consume(res, encoding))
        })
    })
    req.end(data, dataEnc)
    return p.get()
}
