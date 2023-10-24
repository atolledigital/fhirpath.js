// This is fhirpath interpreter
// everything starts at evaluate function,
// which is passed  fhirpath AST and resource.
//
// We reduce/eval recursively each node in AST
// passing the context and current data
//
// each AST node has eval function, which should be registered in evalTable
// and named after node type
// if node needs to eval father it's children it has to call `doEval` function
//
// most of nodes do function or operator invocation at the end
//
// For invocation's and operator's there is one lookup table -
// invocationTable and two helper functions doInvoke and infixInvoke for
// operators
// 1. operator or function is looked up in table
// 2. using signature (in  .arity property) unpack parameters
// 3. check params types
// 4. do call function
// 5. wrap result by util.arraify
//
// if function is nullable
// and one of parameters is empty/null - function will not be invoked and empty
// result returned
//
// Not solved problem is overloading functions by types - for example + operator defined
// for strings and numbers
// we can make dispatching params type dependent - let see

const {version} = require('../package.json');
const parser = require("./parser");
const util = require("./utilities");
require("./polyfill");
const constants = require('./constants');

let engine    = {}; // the object with all FHIRPath functions and operations
let existence = require("./existence");
let filtering = require("./filtering");
let aggregate = require("./aggregate");
let combining = require("./combining");
let misc      = require("./misc");
let equality  = require("./equality");
let collections  = require("./collections");
let math      = require("./math");
let strings   = require("./strings");
let navigation= require("./navigation");
let datetime  = require("./datetime");
let logic  = require("./logic");
const types = require("./types");
const {
  FP_Date, FP_DateTime, FP_Time, FP_Quantity,
  FP_Type, ResourceNode, TypeInfo
} = types;
let makeResNode = ResourceNode.makeResNode;

// * fn: handler
// * arity: is index map with type signature
//   if type is in array (like [Boolean]) - this means
//   function accepts value of this type or empty value {}
// * nullable - means propagate empty result, i.e. instead
//   calling function if one of params is  empty return empty

engine.invocationTable = {
  empty:        {fn: existence.emptyFn},
  not:          {fn: existence.notFn},
  exists:       {fn: existence.existsMacro, arity: {0: [], 1: ["Expr"]}},
  all:          {fn: existence.allMacro, arity: {1: ["Expr"]}},
  allTrue:      {fn: existence.allTrueFn},
  anyTrue:      {fn: existence.anyTrueFn},
  allFalse:     {fn: existence.allFalseFn},
  anyFalse:     {fn: existence.anyFalseFn},
  subsetOf:     {fn: existence.subsetOfFn, arity: {1: ["AnyAtRoot"]}},
  supersetOf:   {fn: existence.supersetOfFn, arity: {1: ["AnyAtRoot"]}},
  isDistinct:   {fn: existence.isDistinctFn},
  distinct:     {fn: filtering.distinctFn},
  count:        {fn: aggregate.countFn},
  where:        {fn: filtering.whereMacro, arity: {1: ["Expr"]}},
  extension:    {fn: filtering.extension, arity: {1: ["String"]}},
  select:       {fn: filtering.selectMacro, arity: {1: ["Expr"]}},
  aggregate:    {fn: aggregate.aggregateMacro, arity: {1: ["Expr"], 2: ["Expr", "Any"]}},
  sum:          {fn: aggregate.sumFn},
  min:          {fn: aggregate.minFn},
  max:          {fn: aggregate.maxFn},
  avg:          {fn: aggregate.avgFn},
  single:       {fn: filtering.singleFn},
  first:        {fn: filtering.firstFn},
  last:         {fn: filtering.lastFn},
  type:         {fn: types.typeFn, arity: {0: []}},
  ofType:       {fn: filtering.ofTypeFn, arity: {1: ["TypeSpecifier"]}},
  is:           {fn: types.isFn, arity: {1: ["TypeSpecifier"]}},
  as:           {fn: types.asFn, arity: {1: ["TypeSpecifier"]}},
  tail:         {fn: filtering.tailFn},
  take:         {fn: filtering.takeFn, arity: {1: ["Integer"]}},
  skip:         {fn: filtering.skipFn, arity: {1: ["Integer"]}},
  combine:      {fn: combining.combineFn, arity: {1: ["AnyAtRoot"]}},
  union:        {fn: combining.union,   arity: {1: ["AnyAtRoot"]}},
  intersect:    {fn: combining.intersect,   arity: {1: ["AnyAtRoot"]}},
  exclude:      {fn: combining.exclude,   arity: {1: ["AnyAtRoot"]}},
  iif:          {fn: misc.iifMacro,    arity: {2: ["Expr", "Expr"], 3: ["Expr", "Expr", "Expr"]}},
  trace:        {fn: misc.traceFn,     arity: {1: ["String"], 2: ["String", "Expr"]}},
  toInteger:    {fn: misc.toInteger},
  toDecimal:    {fn: misc.toDecimal},
  toString:     {fn: misc.toString},
  toDate:       {fn: misc.toDate},
  toDateTime:   {fn: misc.toDateTime},
  toTime:       {fn: misc.toTime},
  toBoolean:    {fn: misc.toBoolean},
  toQuantity:   {fn: misc.toQuantity, arity: {0: [], 1: ["String"]}},
  hasValue:     {fn: misc.hasValueFn},
  convertsToBoolean:    {fn: misc.createConvertsToFn(misc.toBoolean, 'boolean')},
  convertsToInteger:    {fn: misc.createConvertsToFn(misc.toInteger, 'number')},
  convertsToDecimal:    {fn: misc.createConvertsToFn(misc.toDecimal, 'number')},
  convertsToString:     {fn: misc.createConvertsToFn(misc.toString, 'string')},
  convertsToDate:       {fn: misc.createConvertsToFn(misc.toDate, FP_Date)},
  convertsToDateTime:   {fn: misc.createConvertsToFn(misc.toDateTime, FP_DateTime)},
  convertsToTime:       {fn: misc.createConvertsToFn(misc.toTime, FP_Time)},
  convertsToQuantity:   {fn: misc.createConvertsToFn(misc.toQuantity, FP_Quantity)},

  indexOf:        {fn: strings.indexOf,          arity: {1: ["String"]}},
  substring:      {fn: strings.substring,        arity: {1: ["Integer"], 2: ["Integer","Integer"]}},
  startsWith:     {fn: strings.startsWith,       arity: {1: ["String"]}},
  endsWith:       {fn: strings.endsWith,         arity: {1: ["String"]}},
  contains:       {fn: strings.containsFn,       arity: {1: ["String"]}},
  upper:          {fn: strings.upper},
  lower:          {fn: strings.lower},
  replace:        {fn: strings.replace,          arity: {2: ["String", "String"]}},
  matches:        {fn: strings.matches,          arity: {1: ["String"]}},
  replaceMatches: {fn: strings.replaceMatches,   arity: {2: ["String", "String"]}},
  length:         {fn: strings.length },
  toChars:        {fn: strings.toChars },
  join:           {fn: strings.joinFn,           arity: {0: [], 1: ["String"]}},
  split:          {fn: strings.splitFn,          arity: {1: ["String"]}},
  trim:           {fn: strings.trimFn},

  encode:         {fn: strings.encodeFn,         arity: {1: ["String"]}},
  decode:         {fn: strings.decodeFn,         arity: {1: ["String"]}},

  abs:            {fn: math.abs},
  ceiling:        {fn: math.ceiling},
  exp:            {fn: math.exp},
  floor:          {fn: math.floor},
  ln:             {fn: math.ln},
  log:            {fn: math.log, arity:  {1: ["Number"]}, nullable: true},
  power:          {fn: math.power, arity:  {1: ["Number"]}, nullable: true},
  round:          {fn: math.round, arity:  {1: ["Number"]}},
  sqrt:           {fn: math.sqrt},
  truncate:       {fn: math.truncate},

  now:            {fn: datetime.now },
  today:          {fn: datetime.today },
  timeOfDay:      {fn: datetime.timeOfDay },

  repeat:          {fn: filtering.repeatMacro, arity: {1: ["Expr"]}},
  children:        {fn: navigation.children },
  descendants:     {fn: navigation.descendants },

  "|":          {fn: combining.union,   arity: {2: ["Any", "Any"]}},
  "=":          {fn: equality.equal,   arity: {2: ["Any", "Any"]}, nullable: true},
  "!=":         {fn: equality.unequal,   arity: {2: ["Any", "Any"]}, nullable: true},
  "~":          {fn: equality.equival,   arity: {2: ["Any", "Any"]}},
  "!~":         {fn: equality.unequival,   arity: {2: ["Any", "Any"]}},
  "<":          {fn: equality.lt,   arity: {2: ["Any", "Any"]}, nullable: true},
  ">":          {fn: equality.gt,   arity: {2: ["Any", "Any"]}, nullable: true},
  "<=":         {fn: equality.lte,  arity: {2: ["Any", "Any"]}, nullable: true},
  ">=":         {fn: equality.gte,  arity: {2: ["Any", "Any"]}, nullable: true},
  "containsOp": {fn: collections.contains,   arity: {2: ["Any", "Any"]}},
  "inOp":       {fn: collections.in,  arity: {2: ["Any", "Any"]}},
  "isOp":       {fn: types.isFn,  arity: {2: ["Any", "TypeSpecifier"]}},
  "asOp":       {fn: types.asFn,  arity: {2: ["Any", "TypeSpecifier"]}},
  "&":          {fn: math.amp,     arity:  {2: ["String", "String"]}},
  "+":          {fn: math.plus,    arity:  {2: ["Any", "Any"]}, nullable: true},
  "-":          {fn: math.minus,   arity:  {2: ["Any", "Any"]}, nullable: true},
  "*":          {fn: math.mul,     arity:  {2: ["Number", "Number"]}, nullable: true},
  "/":          {fn: math.div,     arity:  {2: ["Number", "Number"]}, nullable: true},
  "mod":        {fn: math.mod,     arity:  {2: ["Number", "Number"]}, nullable: true},
  "div":        {fn: math.intdiv,  arity:  {2: ["Number", "Number"]}, nullable: true},

  "or":        {fn: logic.orOp,  arity:       {2: [["Boolean"], ["Boolean"]]}},
  "and":       {fn: logic.andOp,  arity:      {2: [["Boolean"], ["Boolean"]]}},
  "xor":       {fn: logic.xorOp,  arity:      {2: [["Boolean"], ["Boolean"]]}},
  "implies":   {fn: logic.impliesOp,  arity:  {2: [["Boolean"], ["Boolean"]]}},
};

engine.InvocationExpression = function(ctx, parentData, node) {
  return node.children.reduce(function(acc, ch) {
    return engine.doEval(ctx, acc, ch);
  }, parentData);
};

engine.TermExpression = function(ctx, parentData, node) {
  if (parentData) {
    parentData = parentData.map((x) => {
      if (x instanceof Object && x.resourceType) {
        return makeResNode(x, x.resourceType);
      }
      return x;
    });
  }

  return engine.doEval(ctx,parentData, node.children[0]);
};

engine.PolarityExpression = function(ctx, parentData, node) {
  var sign = node.terminalNodeText[0]; // either - or + per grammar
  var rtn = engine.doEval(ctx,parentData, node.children[0]);
  if (rtn.length !== 1) {  // not yet in spec, but per Bryn Rhodes
    throw new Error('Unary ' + sign +
     ' can only be applied to an individual number.');
  }
  if (typeof rtn[0] != 'number' || isNaN(rtn[0]))
    throw new Error('Unary ' + sign + ' can only be applied to a number.');
  if (sign === '-')
    rtn[0] = -rtn[0];
  return rtn;
};

engine.TypeSpecifier = function(ctx, parentData, node) {
  let namespace, name;
  const identifiers = node.text.split('.').map(i => i.replace(/(^`|`$)/g, ""));
  switch (identifiers.length) {
    case 2:
      [namespace, name] = identifiers;
      break;
    case 1:
      [name] = identifiers;
      break;
    default:
      throw new Error("Expected TypeSpecifier node, got " + JSON.stringify(node));
  }

  return new TypeInfo({ namespace, name });
};

engine.ExternalConstantTerm = function(ctx, parentData, node) {
  var extConstant = node.children[0];
  var identifier = extConstant.children[0];
  var varName = engine.Identifier(ctx, parentData, identifier)[0];
  var value = ctx.vars[varName];
  if (!(varName in ctx.vars)) {
    throw new Error(
      "Attempting to access an undefined environment variable: " + varName
    );
  }
  // For convenience, we all variable values to be passed in without their array
  // wrapper.  However, when evaluating, we need to put the array back in.
  return value === undefined || value === null
    ? []
    : value instanceof Array ? value : [value];
};

engine.LiteralTerm = function(ctx, parentData, node) {
  var term = node.children[0];
  if(term){
    return engine.doEval(ctx, parentData, term);
  } else {
    return [node.text];
  }
};

engine.StringLiteral = function(ctx, parentData, node) {
  // Remove the beginning and ending quotes.
  var rtn = node.text.replace(/(^'|'$)/g, "");
  rtn = rtn.replace(/\\(u\d{4}|.)/g, function(match, submatch) {
    switch(match) {
      case '\\r':
        return '\r';
      case '\\n':
        return "\n";
      case '\\t':
        return '\t';
      case '\\f':
        return '\f';
      default:
        if (submatch.length > 1)
          return String.fromCharCode('0x'+submatch.slice(1));
        else
          return submatch;
    }
  });
  return [rtn];
};

engine.BooleanLiteral = function(ctx, parentData, node) {
  if(node.text  === "true") {
    return [true];
  } else {
    return [false];
  }
};

engine.QuantityLiteral = function(ctx, parentData, node) {
  var valueNode = node.children[0];
  var value = Number(valueNode.terminalNodeText[0]);
  var unitNode = valueNode.children[0];
  var unit = unitNode.terminalNodeText[0];
  // Sometimes the unit is in a child node of the child
  if (!unit && unitNode.children)
    unit = unitNode.children[0].terminalNodeText[0];

  return [new FP_Quantity(value, unit)];
};

engine.DateTimeLiteral = function(ctx, parentData, node) {
  var dateStr = node.text.slice(1); // Remove the @
  return [new FP_DateTime(dateStr)];
};

engine.TimeLiteral = function(ctx, parentData, node) {
  var timeStr = node.text.slice(1); // Remove the @
  return [new FP_Time(timeStr)];
};

engine.NumberLiteral = function(ctx, parentData, node) {
  return [Number(node.text)];
};

engine.Identifier = function(ctx, parentData, node) {
  return [node.text.replace(/(^`|`$)/g, "")];
};

engine.InvocationTerm = function(ctx, parentData, node) {
  return engine.doEval(ctx,parentData, node.children[0]);
};


engine.MemberInvocation = function(ctx, parentData, node ) {
  const key = engine.doEval(ctx, parentData, node.children[0])[0];
  const model = ctx.model;

  if (parentData) {
    if(util.isCapitalized(key)) {
      return parentData
        .filter((x) => x instanceof ResourceNode && x.path === key);
    } else {
      const path = parentData.path || parentData.__path__;
      return parentData.reduce(function(acc, res) {
        res = makeResNode(res, path);
        var childPath = res.path + '.' + key;
        if (model) {
          let defPath = model.pathsDefinedElsewhere[childPath];
          if (defPath)
            childPath = defPath;
        }
        let toAdd, _toAdd;
        let actualTypes = model && model.choiceTypePaths[childPath];
        if (actualTypes) {
          // Use actualTypes to find the field's value
          for (let t of actualTypes) {
            let field = key + t;
            toAdd = res.data?.[field];
            _toAdd = res.data?.['_' + field];
            if (toAdd !== undefined || _toAdd !== undefined) {
              childPath += t;
              break;
            }
          }
        }
        else {
          toAdd = res.data?.[key];
          _toAdd = res.data?.['_' + key];
          if (toAdd === undefined && _toAdd === undefined) {
            toAdd = res._data[key];
          }
          if (key === 'extension') {
            childPath = 'Extension';
          }
        }
        childPath = model && model.path2Type[childPath] || childPath;

        if (util.isSome(toAdd) || util.isSome(_toAdd)) {
          if(Array.isArray(toAdd)) {
            acc = acc.concat(toAdd.map((x, i)=>
              makeResNode(x, childPath, _toAdd && _toAdd[i])));
          } else {
            acc.push(makeResNode(toAdd, childPath, _toAdd));
          }
          return acc;
        } else {
          return acc;
        }
      }, []);
    }
  } else {
    return [];
  }
};

engine.IndexerExpression = function(ctx, parentData, node) {
  const coll_node = node.children[0];
  const idx_node = node.children[1];
  var coll = engine.doEval(ctx, parentData, coll_node);
  var idx = engine.doEval(ctx, parentData, idx_node);

  if(util.isEmpty(idx)) {
    return [];
  }

  var idxNum = parseInt(idx[0]);
  if(coll && util.isSome(idxNum) && coll.length>idxNum && idxNum>=0) {
    return [coll[idxNum]];
  } else {
    return [];
  }
};

engine.Functn = function(ctx, parentData, node) {
  return node.children.map(function(x) {
    return engine.doEval(ctx, parentData, x);
  });
};

engine.realizeParams = function(ctx, parentData, args) {
  if(args && args[0] && args[0].children) {
    return args[0].children.map(function(x) {
      return engine.doEval(ctx, parentData, x);
    });
  } else {
    return [];
  }
};

function makeParam(ctx, parentData, type, param) {
  if(type === "Expr"){
    return function(data) {
      const $this = util.arraify(data);
      return engine.doEval({ ...ctx, $this }, $this, param);
    };
  }
  if(type === "AnyAtRoot"){
    const $this = ctx.$this || ctx.dataRoot;
    return engine.doEval({ ...ctx, $this}, $this, param);
  }
  if(type === "Identifier"){
    if(param.type === "TermExpression") {
      return param.text;
    } else {
      throw new Error("Expected identifier node, got " + JSON.stringify(param));
    }
  }

  if(type === "TypeSpecifier") {
    return engine.TypeSpecifier(ctx, parentData, param);
  }

  const res = engine.doEval(ctx, parentData, param);
  if(type === "Any") {
    return res;
  }
  if(Array.isArray(type)) {
    if(res.length === 0) {
      return [];
    } else {
      type = type[0];
    }
  }
  return misc.singleton(res, type);
}

function doInvoke(ctx, fnName, data, rawParams){
  var invoc = ctx.userInvocationTable?.[fnName] ?? engine.invocationTable[fnName];
  var res;
  if(invoc) {
    if(!invoc.arity){
      if(!rawParams){
        res = invoc.fn.call(ctx, util.arraify(data));
        return util.arraify(res);
      } else {
        throw new Error(fnName + " expects no params");
      }
    } else {
      var paramsNumber = rawParams ? rawParams.length : 0;
      var argTypes = invoc.arity[paramsNumber];
      if(argTypes){
        var params = [];
        for(var i = 0; i < paramsNumber; i++){
          var tp = argTypes[i];
          var pr = rawParams[i];
          params.push(makeParam(ctx, data, tp, pr));
        }
        params.unshift(data);
        if(invoc.nullable) {
          if(params.some(isNullable)){
            return [];
          }
        }
        res = invoc.fn.apply(ctx, params);
        return util.arraify(res);
      } else {
        console.log(fnName + " wrong arity: got " + paramsNumber );
        return [];
      }
    }
  } else {
    throw new Error("Not implemented: " + fnName);
  }
}
function isNullable(x) {
  return x === null || x === undefined || util.isEmpty(x);
}

function infixInvoke(ctx, fnName, data, rawParams){
  var invoc = engine.invocationTable[fnName];
  if(invoc && invoc.fn) {
    var paramsNumber = rawParams ? rawParams.length : 0;
    if(paramsNumber !== 2) { throw new Error("Infix invoke should have arity 2"); }
    var argTypes = invoc.arity[paramsNumber];
    if(argTypes){
      var params = [];
      for(var i = 0; i < paramsNumber; i++){
        var tp = argTypes[i];
        var pr = rawParams[i];
        params.push(makeParam(ctx, data, tp, pr));
      }
      if(invoc.nullable) {
        if(params.some(isNullable)){
          return [];
        }
      }
      var res = invoc.fn.apply(ctx, params);
      return util.arraify(res);
    } else {
      console.log(fnName + " wrong arity: got " + paramsNumber );
      return [];
    }
  } else {
    throw new Error("Not impl " + fnName);
  }
}

engine.FunctionInvocation = function(ctx, parentData, node) {
  var args = engine.doEval(ctx, parentData, node.children[0]);
  const fnName = args[0];
  args.shift();
  var rawParams = args && args[0] && args[0].children;
  return doInvoke(ctx, fnName, parentData, rawParams);
};

engine.ParamList = function(ctx, parentData, node) {
  // we do not eval param list because sometimes it should be passed as
  // lambda/macro (for example in case of where(...)
  return node;
};


engine.UnionExpression = function(ctx, parentData, node) {
  return infixInvoke(ctx, '|', parentData, node.children);
};

engine.ThisInvocation = function(ctx) {
  return ctx.$this;
};

engine.TotalInvocation = function(ctx) {
  return util.arraify(ctx.$total);
};

engine.IndexInvocation = function(ctx) {
  return util.arraify(ctx.$index);
};

engine.OpExpression = function(ctx, parentData, node) {
  var op = node.terminalNodeText[0];
  return infixInvoke(ctx, op, parentData, node.children);
};

engine.AliasOpExpression = function(map){
  return function(ctx, parentData, node) {
    var op = node.terminalNodeText[0];
    var alias = map[op];
    if(!alias) { throw new Error("Do not know how to alias " + op + " by " + JSON.stringify(map)); }
    return infixInvoke(ctx, alias, parentData, node.children);
  };
};

engine.NullLiteral = function() {
  return [];
};

engine.ParenthesizedTerm = function(ctx, parentData, node) {
  return engine.doEval(ctx, parentData, node.children[0]);
};


engine.evalTable = { // not every evaluator is listed if they are defined on engine
  BooleanLiteral: engine.BooleanLiteral,
  EqualityExpression: engine.OpExpression,
  FunctionInvocation: engine.FunctionInvocation,
  Functn: engine.Functn,
  Identifier: engine.Identifier,
  IndexerExpression: engine.IndexerExpression,
  InequalityExpression: engine.OpExpression,
  InvocationExpression: engine.InvocationExpression,
  AdditiveExpression: engine.OpExpression,
  MultiplicativeExpression: engine.OpExpression,
  TypeExpression: engine.AliasOpExpression({"is": "isOp", "as": "asOp"}),
  MembershipExpression: engine.AliasOpExpression({"contains": "containsOp", "in": "inOp"}),
  NullLiteral: engine.NullLiteral,
  EntireExpression: engine.InvocationTerm,
  InvocationTerm: engine.InvocationTerm,
  LiteralTerm: engine.LiteralTerm,
  MemberInvocation: engine.MemberInvocation,
  NumberLiteral: engine.NumberLiteral,
  ParamList: engine.ParamList,
  ParenthesizedTerm: engine.ParenthesizedTerm,
  StringLiteral: engine.StringLiteral,
  TermExpression: engine.TermExpression,
  ThisInvocation: engine.ThisInvocation,
  TotalInvocation: engine.TotalInvocation,
  IndexInvocation: engine.IndexInvocation,
  UnionExpression: engine.UnionExpression,
  OrExpression: engine.OpExpression,
  ImpliesExpression: engine.OpExpression,
  AndExpression: engine.OpExpression,
  XorExpression: engine.OpExpression
};


engine.doEval = function(ctx, parentData, node) {
  const evaluator = engine.evalTable[node.type] || engine[node.type];
  if(evaluator){
    return evaluator.call(engine, ctx, parentData, node);
  } else {
    throw new Error("No " + node.type + " evaluator ");
  }
};

function parse(path) {
  return parser.parse(path);
}


/**
 *  Applies the given parsed FHIRPath expression to the given resource,
 *  returning the result of doEval.
 * @param {(object|object[])} resource -  FHIR resource, bundle as js object or array of resources
 *  This resource will be modified by this function to add type information.
 * @param {object} parsedPath - a special object created by the parser that describes the structure of a fhirpath expression.
 * @param {object} context - a hash of variable name/value pairs.
 * @param {object} model - The "model" data object specific to a domain, e.g. R4.
 *  For example, you could pass in the result of require("fhirpath/fhir-context/r4");
 * @param {object} options - additional options:
 * @param {boolean} [options.resolveInternalTypes] - whether values of internal
 *  types should be converted to strings, true by default.
 * @param {function} [options.traceFn] - An optional trace function to call when tracing.
 * @param {object} [options.userInvocationTable] - a user invocation table used
 *  to replace any existing or define new functions.
 */
function applyParsedPath(resource, parsedPath, context, model, options) {
  constants.reset();
  let dataRoot = util.arraify(resource).map(i => (i?.__path__ ? makeResNode(i, i?.__path__) : i));
  // doEval takes a "ctx" object, and we store things in that as we parse, so we
  // need to put user-provided variable data in a sub-object, ctx.vars.
  // Set up default standard variables, and allow override from the variables.
  // However, we'll keep our own copy of dataRoot for internal processing.
  let vars = {context: dataRoot, ucum: 'http://unitsofmeasure.org'};
  // Restore the ResourceNodes for the top-level objects of the context
  // variables. The nested objects will be converted to ResourceNodes
  // in the MemberInvocation method.
  if (context) {
    context = Object.keys(context).reduce((restoredContext, key) => {
      if (Array.isArray(context[key])) {
        restoredContext[key] = context[key].map(i => (i?.__path__ ? makeResNode(i, i.__path__) : i));
      } else {
        restoredContext[key] = context[key]?.__path__ ? makeResNode(context[key], context[key].__path__) : context[key];
      }
      return restoredContext;
    }, {});
  }
  let ctx = {dataRoot, vars: Object.assign(vars, context), model};
  if (options.traceFn) {
    ctx.customTraceFn = options.traceFn;
  }
  if (options.userInvocationTable) {
    ctx.userInvocationTable = options.userInvocationTable;
  }
  return  engine.doEval(ctx, dataRoot, parsedPath.children[0])
    // engine.doEval returns array of "ResourceNode" and/or "FP_Type" instances.
    // "ResourceNode" or "FP_Type" instances are not created for sub-items.
    // Resolve any internal "ResourceNode" instances to plain objects and if
    // options.resolveInternalTypes is true, resolve any internal "FP_Type"
    // instances to strings.
    .map(n => {
      // Path for the data extracted from the resource.
      let path = n instanceof ResourceNode ? n.path : null;
      n = util.valData(n);
      if (n instanceof FP_Type) {
        if (options.resolveInternalTypes) {
          n = n.toString();
        }
      }
      // Add a hidden (non-enumerable) property with the path to the data extracted
      // from the resource.
      if (path && typeof n === 'object') {
        Object.defineProperty(n, '__path__', {value: path});
      }
      return n;
    });
}

/**
 * Resolves any internal "FP_Type" instances in a result of FHIRPath expression
 * evaluation to standard JavaScript types.
 * @param {any} val - a result of FHIRPath expression evaluation
 * @returns {any} a new object with resolved values.
 */
function resolveInternalTypes(val) {
  if (Array.isArray(val)) {
    for (let i=0, len=val.length; i<len; ++i)
      val[i] = resolveInternalTypes(val[i]);
  }
  else if (val instanceof FP_Type) {
    val = val.toString();
  }
  else if (typeof val === 'object') {
    for (let k of Object.keys(val))
      val[k] = resolveInternalTypes(val[k]);
  }
  return val;
}

/**
 *  Evaluates the "path" FHIRPath expression on the given resource or part of the resource,
 *  using data from "context" for variables mentioned in the "path" expression.
 * @param {(object|object[])} fhirData -  FHIR resource, part of a resource (in this case
 *  path.base should be provided), bundle as js object or array of resources.
 *  This object/array will be modified by this function to add type information.
 * @param {string|object} path - string with FHIRPath expression, sample 'Patient.name.given',
 *  or object, if fhirData represents the part of the FHIR resource:
 * @param {string} path.base - base path in resource from which fhirData was extracted
 * @param {string} path.expression - FHIRPath expression relative to path.base
 * @param {object} [context] - a hash of variable name/value pairs.
 * @param {object} [model] - The "model" data object specific to a domain, e.g. R4.
 *  For example, you could pass in the result of require("fhirpath/fhir-context/r4");
 * @param {object} [options] - additional options:
 * @param {boolean} [options.resolveInternalTypes] - whether values of internal
 *  types should be converted to standard JavaScript types (true by default).
 *  If false is passed, this conversion can be done later by calling
 *  resolveInternalTypes().
 * @param {function} [options.traceFn] - An optional trace function to call when tracing.
 * @param {object} [options.userInvocationTable] - a user invocation table used
 *  to replace any existing or define new functions.
 */
function evaluate(fhirData, path, context, model, options) {
  return compile(path, model, options)(fhirData, context);
}

/**
 *  Returns a function that takes a resource or part of the resource and an
 *  optional context hash (see "evaluate"), and returns the result of evaluating
 *  the given FHIRPath expression on that resource.  The advantage of this
 *  function over "evaluate" is that if you have multiple resources, the given
 *  FHIRPath expression will only be parsed once.
 * @param {string|object} path - string with FHIRPath expression to be parsed or object:
 * @param {string} path.base - base path in resource from which a part of
 *   the resource was extracted
 * @param {string} path.expression - FHIRPath expression relative to path.base
 * @param {object} [model] - The "model" data object specific to a domain, e.g. R4.
 *  For example, you could pass in the result of require("fhirpath/fhir-context/r4");
 * @param {object} [options] - additional options:
 * @param {boolean} [options.resolveInternalTypes] - whether values of internal
 *  types should be converted to strings, true by default.
 * @param {function} [options.traceFn] - An optional trace function to call when tracing.
 * @param {object} [options.userInvocationTable] - a user invocation table used
 *  to replace any existing or define new functions.
 */
function compile(path, model, options) {
  options = {
    resolveInternalTypes: true,
    ... options
  };
  if (typeof path === 'object') {
    const node = parse(path.expression);
    return function (fhirData, context) {
      const resource = path.base ? makeResNode(fhirData, path.base) : fhirData;
      // Globally set model before applying parsed FHIRPath expression
      TypeInfo.model = model;
      return applyParsedPath(resource, node, context, model, options);
    };
  } else {
    const node = parse(path);
    return function (fhirData, context) {
      // Globally set model before applying parsed FHIRPath expression
      TypeInfo.model = model;
      return applyParsedPath(fhirData, node, context, model, options);
    };
  }
}

/**
 * Returns the type of each element in fhirpathResult array which was obtained
 * from evaluate() with option resolveInternalTypes=false.
 * @param {any} fhirpathResult - a result of FHIRPath expression evaluation.
 * @returns {string[]} an array of types, e.g. ['FHIR.Quantity', 'FHIR.date', 'System.String'].
 */
function typesFn(fhirpathResult) {
  return util.arraify(fhirpathResult).map(value => {
    const ti = TypeInfo.fromValue(value?.__path__ ? new ResourceNode(value, value.__path__) : value);
    return `${ti.namespace}.${ti.name}`;
  });
}

module.exports = {
  version,
  parse,
  compile,
  evaluate,
  resolveInternalTypes,
  types: typesFn,
  // Might as well export the UCUM library, since we are using it.
  ucumUtils: require('@lhncbc/ucum-lhc').UcumLhcUtils.getInstance()
};
