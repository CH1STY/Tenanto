// Minimal in-memory stand-in for a MongoDB collection: just enough of the
// query language and the aggregation-pipeline update syntax used by the rate
// limiters, evaluated for real so tests exercise the actual pipelines.

function evaluate(expr, doc) {
  if (typeof expr === "string" && expr.startsWith("$")) return doc[expr.slice(1)];
  if (Array.isArray(expr)) return expr.map((item) => evaluate(item, doc));
  if (expr && typeof expr === "object" && !(expr instanceof Date)) {
    const [op, ...rest] = Object.keys(expr);
    if (rest.length || !op.startsWith("$")) throw new Error(`Unsupported expression ${JSON.stringify(expr)}`);
    const args = expr[op];
    const value = (index) => evaluate(args[index], doc);
    switch (op) {
      case "$cond": return value(0) ? value(1) : value(2);
      case "$ifNull": return value(0) ?? value(1);
      case "$lte": return value(0) <= value(1);
      case "$gte": return value(0) >= value(1);
      case "$add": return args.reduce((sum, item) => sum + evaluate(item, doc), 0);
      case "$or": return args.some((item) => evaluate(item, doc));
      case "$toDate": return new Date(evaluate(args, doc));
      default: throw new Error(`Unsupported operator ${op}`);
    }
  }
  return expr;
}

function matches(doc, filter) {
  return Object.entries(filter).every(([key, condition]) => {
    if (condition && typeof condition === "object" && "$gt" in condition) {
      return doc[key] > condition.$gt;
    }
    return doc[key] === condition;
  });
}

export function fakeCollection(initial = []) {
  const docs = new Map(initial.map((doc) => [doc._id, { ...doc }]));
  const calls = [];
  return {
    docs,
    calls,
    async findOne(filter) {
      calls.push(["findOne", filter]);
      const doc = docs.get(filter._id);
      return doc && matches(doc, filter) ? { ...doc } : null;
    },
    async findOneAndUpdate(filter, pipeline, options) {
      calls.push(["findOneAndUpdate", filter, options]);
      let doc = docs.get(filter._id);
      if (!doc && !options?.upsert) return null;
      doc = { ...(doc ?? { _id: filter._id }) };
      for (const stage of pipeline) {
        const updates = Object.fromEntries(
          Object.entries(stage.$set).map(([key, expr]) => [key, evaluate(expr, doc)]),
        );
        doc = { ...doc, ...updates };
      }
      docs.set(doc._id, doc);
      return { ...doc };
    },
    async updateOne(filter, update) {
      calls.push(["updateOne", filter, update]);
      const doc = docs.get(filter._id);
      if (!doc || !matches(doc, filter)) return { matchedCount: 0 };
      for (const [key, by] of Object.entries(update.$inc ?? {})) doc[key] = (doc[key] ?? 0) + by;
      return { matchedCount: 1 };
    },
    async deleteOne(filter) {
      calls.push(["deleteOne", filter]);
      return { deletedCount: docs.delete(filter._id) ? 1 : 0 };
    },
    async createIndex(spec, options) {
      calls.push(["createIndex", spec, options]);
      return "expiresAt_1";
    },
  };
}

export function fakeDb(collections) {
  return {
    connectDB: async () => ({
      connection: {
        db: {
          collection: (name) => {
            if (!collections[name]) throw new Error(`Unexpected collection ${name}`);
            return collections[name];
          },
        },
      },
    }),
  };
}
