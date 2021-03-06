
function logError(err, notes) {
	if (typeof(err) == 'object')
    	console.log('error: ' + (err.stack || _.json(err, true)))
    else
    	console.log('error: ' + err)
	console.log('notes: ' + notes)
}

process.on('uncaughtException', function (err) {
    try {
    	console.log("PAYMENT ERROR!")
		logError(err)
		process.exit(1)
	} catch (e) {}
})

function getAll(o, path, params) {
	var kind = path.match(/([^\/]+)s(\?|$)/)[1]
	var kinds = kind + 's'
	if (!params) params = {}

	var accum = []
	var offset = 0
	var pageSize = 100
	var p = _.promiseErr()
	while (true) {
		params.page = offset + ';' + pageSize
		o.get(path, params, p.set)
		var a = p.get()[kinds]
		var b = a[kind]
		if (b) {
			if (b instanceof Array)
				accum.push(b)
			else
				accum.push([b])
		} else {
			break
		}
		offset += pageSize
		if (offset >= a.lister.total_count)
			break
	}
	return [].concat.apply([], accum)
}

require('./u.js')
require('./nodeutil.js')
_.run(function () {

	var teams = _.makeSet(process.env.TEAMS.split(','))

	var mongojs = require('mongojs')
	console.log("connecting to db: " + process.env.MONGOHQ_URL)
	var db = mongojs.connect(process.env.MONGOHQ_URL)
	var p = _.promiseErr()

	var userStats = {}
	function addStat(userid, stat, amount) {
		_.bagAdd(_.ensure(userStats, userid, {}), stat, amount)
	}

	var count = 0
	db.collection('records').find({}).forEach(function (err, doc) {
		if (err || !doc) return p.set(err, doc)

		if (doc.reviewedBy) {
			addStat(doc.reviewedBy, 'reviewAcceptCount')
			addStat(doc.answeredBy, 'answerAcceptedCount')
		} else if (doc.answeredBy) {
			addStat(doc.answeredBy, 'answerPendingCount')
		}
		_.each(doc.history, function (h) {
			if (h.reviewedBy) {
				// note: h.reviewAccept is a hack,
				// it is only set when a reviewer reviewed their own work,
				// before that sort of thing was prevented,
				// but we still want to pay them for their review,
				// since we said we would,
				// but we still want someone else to review their work
				// before we mark it as an accepted answer
				addStat(h.reviewedBy, h.reviewAccept ? 'reviewAcceptCount' : 'reviewRejectCount')
				if (!h.reviewAccept) {
					addStat(h.answeredBy, 'answerRejectedCount')
				}
			}
		})
	})
	p.get()

	var payedSoFarCents = 0
	db.collection('payments').find({}).forEach(function (err, doc) {
		if (err || !doc) return p.set(err, doc)

		payedSoFarCents += doc.payCents
	})
	p.get()

	var odesk = require('node-odesk')
	var o = new odesk(process.env.ODESK_API_KEY, process.env.ODESK_API_SECRET)

	db.collection('users').findOne({ _id : process.env.PAYER }, p.set)
	var payer = p.get()
	o.OAuth.accessToken = payer.accessToken
	o.OAuth.accessTokenSecret = payer.accessTokenSecret

	_.each(userStats, function (u, _id) {

		u.deservedCents = (u.answerAcceptedCount || 0) * 28 + (u.reviewAcceptCount || 0) * 4

		db.collection('users').findOne({ _id : _id }, p.set)
		var user = p.get()

		var payCents = u.deservedCents - _.ensure(user, 'paidCents', 0)

		if (((payedSoFarCents + payCents) / 100) > 1 * (process.env.MAX_PAYOUT || 0)) {
			throw new Error("we've bumped up against our MAX_PAYOUT threshold.. please make sure everything is ok, and adjust the MAX_PAYOUT environment variable to a bigger value to proceed.")
		}

		if (payCents >= 30000) {
			throw new Error('about to pay someone over $300 for 1 hours work.. is that right?')
		}

		if (payCents >= 100) {
			// find the engagement
			if (!user.engagement && user.ref) {
				var es = getAll(o, 'hr/v2/engagements', { provider__reference : user.ref, status : "active" })
				var e = _.find(es, function (e) { return _.has(teams, e.buyer_team__reference) })
				if (e) {
					user.engagement = e.reference
					user.engagementTeam = e.buyer_team__reference
				}
			}

			if (user.engagement) {
				// start payment process
				var payment = {
					_id : mongojs.ObjectId(),
					user : _id,
					payCents : payCents,
					startedAt : _.time()
				}
				db.collection('payments').insert(payment, p.set)
				p.get()

				// actually pay them

				// work here
				console.log("paying: $" + (payCents / 100))

				o.post('hr/v2/teams/' + user.engagementTeam + '/adjustments', {
					engagement__reference : user.engagement,
					amount : payCents / 100,
					comments : 'payment for mocska. thanks!'
				}, p.set)
				var adjustment = p.get().adjustment
				if (!adjustment) throw new Error('failed payment')

				// end payment process
				payedSoFarCents += payCents
				db.collection('users').update({ _id : _id }, {
					$inc : { paidCents : payCents },
					$set : {
						engagement : user.engagement,
						engagementTeam : user.engagementTeam
					}
				}, p.set)
				p.get()

				db.collection('payments').update({ _id : payment._id }, { $set : { endedAt : _.time(), adjustment : adjustment } }, p.set)
				p.get()
			}
		}

		db.collection('users').update({ _id : _id }, {
			$set : { stats : u }
		}, p.set)
		p.get()
	})

	console.log("total paid so far: $" + (payedSoFarCents / 100))

	db.eval("" + function () {
		var recs = db.records.find()
		for (var i = 0; i < recs.length(); i++) {
			var rec = recs[i]
			if (rec.history) {
				for (var ii = 0; ii < rec.history.length; ii++) {
					var h = rec.history[ii]
					if (h.reviewedBy && !h.reviewAccept) {
						h._id = h.answeredBy + " " + h.answeredAt
						h.batch = rec.batch
						h.question = rec.question
						h.category = rec.category
						db.rejects.insert(h)
					}
				}
			}
		}
	}, { nolock : true }, p.set)
	p.get()

	process.exit(1)
})
