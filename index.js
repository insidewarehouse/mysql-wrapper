var mysql = require("mysql"),
	Q = require("q"),
	crypto = require("crypto");

function md5(str) {
	return crypto.createHash("md5").update(str).digest("hex");
}

function paramify(list, prefix) {
	var result = {
		values: {},
		tokens: []
	};

	list.forEach(function (item, itemIndex) {
		var tokenKey = prefix + itemIndex;
		result.tokens.push(":" + tokenKey);
		result.values[tokenKey] = item;
	});

	return result;
}

var Database = function (options) {
	var DB_DEBUG = !!options.showDebugInfo;

	// copy/pasted from the mysql lib docs
	var queryFormat = function queryFormat(query, values) {
		if (!values) return query;

		var formatted = query.replace(/\:(\w+)/g, function (txt, key) {
			if (values.hasOwnProperty(key)) {
				return this.escape(values[key]);
			}
			return txt;
		}.bind(this));

		if (DB_DEBUG) {
			console.log("Formatted query", {sql: formatted, queryId: md5(query)});
		}

		return formatted;
	};

	var getQueryFn = function (context) {
		return function queryFn(query, args) {
			var start = process.hrtime();
			return Q.ninvoke(context, "query", query, args).spread(function (rows) {
				var diff = process.hrtime(start);
				if (DB_DEBUG) {
					console.log("Query", {t: diff[0] + diff[1] / 1e9, queryId: md5(query)});
				}

				return rows;
			});
		};
	};

	var executeTransaction = function (connection, inTransactionFn) {
		var queryFn = getQueryFn(connection),
			transactionComplete = false;

		var transactionScope = {
				query: function (query, args) {
					if (transactionComplete) {
						var error = new Error("Transaction is already closed");
						error.code ="E_TRANSACTION_CLOSED";
						return Q.reject(error);
					}
					return queryFn(query, args);
				}
			};

		return Q.ninvoke(connection, "beginTransaction")
			.then(function () {
				return Q.resolve(inTransactionFn(transactionScope));
			})
			.then(function () {
				return Q.ninvoke(connection, "commit");
			})
			.catch(function (e) {
				return Q.ninvoke(connection, "rollback").then(function () {
					throw e; // rethrow!
				});
			})
			.finally(function () {
				connection.release(); // note: no clue how to assert this actually happened
				transactionComplete = true;
			});
	};

	var pool = mysql.createPool({
		host: options.hostname,
		user: options.username,
		password: options.password,
		database: options.database,
		connectionLimit: 100,
		queryFormat: queryFormat,
		multipleStatements: !!options.multipleStatements
	});

	this.queryFormat = function (query, values) {
		return queryFormat.call(pool, query, values);
	};

	this.paramify = paramify;

	this.query = getQueryFn(pool);

	this.transaction = function (inTransactionFn) {
		return Q.ninvoke(pool, "getConnection").then(function (connection) {
			return executeTransaction(connection, inTransactionFn);
		});
	};

	this.end = function (cb) {
		return pool.end(cb);
	};

};

module.exports = Database;
module.exports.paramify = paramify;
