(function (global, factory) {
  typeof exports === 'object' && typeof module !== 'undefined'
    ? (module.exports = factory(
        require('http'),
        require('fs'),
        require('crypto')
      ))
    : typeof define === 'function' && define.amd
    ? define(['http', 'fs', 'crypto'], factory)
    : ((global =
        typeof globalThis !== 'undefined' ? globalThis : global || self),
      (global.Server = factory(global.http, global.fs, global.crypto)));
})(this, function (http, fs, crypto) {
  'use strict';

  function _interopDefaultLegacy(e) {
    return e && typeof e === 'object' && 'default' in e ? e : { default: e };
  }

  var http__default = /*#__PURE__*/ _interopDefaultLegacy(http);
  var fs__default = /*#__PURE__*/ _interopDefaultLegacy(fs);
  var crypto__default = /*#__PURE__*/ _interopDefaultLegacy(crypto);

  class ServiceError extends Error {
    constructor(message = 'Service Error') {
      super(message);
      this.name = 'ServiceError';
    }
  }

  class NotFoundError extends ServiceError {
    constructor(message = 'Resource not found') {
      super(message);
      this.name = 'NotFoundError';
      this.status = 404;
    }
  }

  class RequestError extends ServiceError {
    constructor(message = 'Request error') {
      super(message);
      this.name = 'RequestError';
      this.status = 400;
    }
  }

  class ConflictError extends ServiceError {
    constructor(message = 'Resource conflict') {
      super(message);
      this.name = 'ConflictError';
      this.status = 409;
    }
  }

  class AuthorizationError extends ServiceError {
    constructor(message = 'Unauthorized') {
      super(message);
      this.name = 'AuthorizationError';
      this.status = 401;
    }
  }

  class CredentialError extends ServiceError {
    constructor(message = 'Forbidden') {
      super(message);
      this.name = 'CredentialError';
      this.status = 403;
    }
  }

  var errors = {
    ServiceError,
    NotFoundError,
    RequestError,
    ConflictError,
    AuthorizationError,
    CredentialError,
  };

  const { ServiceError: ServiceError$1 } = errors;

  function createHandler(plugins, services) {
    return async function handler(req, res) {
      const method = req.method;
      console.info(`<< ${req.method} ${req.url}`);

      // Redirect fix for admin panel relative paths
      if (req.url.slice(-6) == '/admin') {
        res.writeHead(302, {
          Location: `http://${req.headers.host}/admin/`,
        });
        return res.end();
      }

      let status = 200;
      let headers = {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'application/json',
      };
      let result = '';
      let context;

      // NOTE: the OPTIONS method results in undefined result and also it never processes plugins - keep this in mind
      if (method == 'OPTIONS') {
        Object.assign(headers, {
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Credentials': false,
          'Access-Control-Max-Age': '86400',
          'Access-Control-Allow-Headers':
            'X-Requested-With, X-HTTP-Method-Override, Content-Type, Accept, X-Authorization, X-Admin',
        });
      } else {
        try {
          context = processPlugins();
          await handle(context);
        } catch (err) {
          if (err instanceof ServiceError$1) {
            status = err.status || 400;
            result = composeErrorObject(err.code || status, err.message);
          } else {
            // Unhandled exception, this is due to an error in the service code - REST consumers should never have to encounter this;
            // If it happens, it must be debugged in a future version of the server
            console.error(err);
            status = 500;
            result = composeErrorObject(500, 'Server Error');
          }
        }
      }

      res.writeHead(status, headers);
      if (
        context != undefined &&
        context.util != undefined &&
        context.util.throttle
      ) {
        await new Promise((r) => setTimeout(r, 500 + Math.random() * 500));
      }
      res.end(result);

      function processPlugins() {
        const context = { params: {} };
        plugins.forEach((decorate) => decorate(context, req));
        return context;
      }

      async function handle(context) {
        const { serviceName, tokens, query, body } = await parseRequest(req);
        if (serviceName == 'admin') {
          return ({ headers, result } = services['admin'](
            method,
            tokens,
            query,
            body
          ));
        } else if (serviceName == 'favicon.ico') {
          return ({ headers, result } = services['favicon'](
            method,
            tokens,
            query,
            body
          ));
        }

        const service = services[serviceName];

        if (service === undefined) {
          status = 400;
          result = composeErrorObject(
            400,
            `Service "${serviceName}" is not supported`
          );
          console.error('Missing service ' + serviceName);
        } else {
          result = await service(context, { method, tokens, query, body });
        }

        // NOTE: logout does not return a result
        // in this case the content type header should be omitted, to allow checks on the client
        if (result !== undefined) {
          result = JSON.stringify(result);
        } else {
          status = 204;
          delete headers['Content-Type'];
        }
      }
    };
  }

  function composeErrorObject(code, message) {
    return JSON.stringify({
      code,
      message,
    });
  }

  async function parseRequest(req) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const tokens = url.pathname.split('/').filter((x) => x.length > 0);
    const serviceName = tokens.shift();
    const queryString = url.search.split('?')[1] || '';
    const query = queryString
      .split('&')
      .filter((s) => s != '')
      .map((x) => x.split('='))
      .reduce(
        (p, [k, v]) => Object.assign(p, { [k]: decodeURIComponent(v) }),
        {}
      );
    const body = await parseBody(req);

    return {
      serviceName,
      tokens,
      query,
      body,
    };
  }

  function parseBody(req) {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk.toString()));
      req.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          resolve(body);
        }
      });
    });
  }

  var requestHandler = createHandler;

  class Service {
    constructor() {
      this._actions = [];
      this.parseRequest = this.parseRequest.bind(this);
    }

    /**
     * Handle service request, after it has been processed by a request handler
     * @param {*} context Execution context, contains result of middleware processing
     * @param {{method: string, tokens: string[], query: *, body: *}} request Request parameters
     */
    async parseRequest(context, request) {
      for (let { method, name, handler } of this._actions) {
        if (
          method === request.method &&
          matchAndAssignParams(context, request.tokens[0], name)
        ) {
          return await handler(
            context,
            request.tokens.slice(1),
            request.query,
            request.body
          );
        }
      }
    }

    /**
     * Register service action
     * @param {string} method HTTP method
     * @param {string} name Action name. Can be a glob pattern.
     * @param {(context, tokens: string[], query: *, body: *)} handler Request handler
     */
    registerAction(method, name, handler) {
      this._actions.push({ method, name, handler });
    }

    /**
     * Register GET action
     * @param {string} name Action name. Can be a glob pattern.
     * @param {(context, tokens: string[], query: *, body: *)} handler Request handler
     */
    get(name, handler) {
      this.registerAction('GET', name, handler);
    }

    /**
     * Register POST action
     * @param {string} name Action name. Can be a glob pattern.
     * @param {(context, tokens: string[], query: *, body: *)} handler Request handler
     */
    post(name, handler) {
      this.registerAction('POST', name, handler);
    }

    /**
     * Register PUT action
     * @param {string} name Action name. Can be a glob pattern.
     * @param {(context, tokens: string[], query: *, body: *)} handler Request handler
     */
    put(name, handler) {
      this.registerAction('PUT', name, handler);
    }

    /**
     * Register PATCH action
     * @param {string} name Action name. Can be a glob pattern.
     * @param {(context, tokens: string[], query: *, body: *)} handler Request handler
     */
    patch(name, handler) {
      this.registerAction('PATCH', name, handler);
    }

    /**
     * Register DELETE action
     * @param {string} name Action name. Can be a glob pattern.
     * @param {(context, tokens: string[], query: *, body: *)} handler Request handler
     */
    delete(name, handler) {
      this.registerAction('DELETE', name, handler);
    }
  }

  function matchAndAssignParams(context, name, pattern) {
    if (pattern == '*') {
      return true;
    } else if (pattern[0] == ':') {
      context.params[pattern.slice(1)] = name;
      return true;
    } else if (name == pattern) {
      return true;
    } else {
      return false;
    }
  }

  var Service_1 = Service;

  function uuid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(
      /[xy]/g,
      function (c) {
        let r = (Math.random() * 16) | 0,
          v = c == 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
      }
    );
  }

  var util = {
    uuid,
  };

  const uuid$1 = util.uuid;

  const data = fs__default['default'].existsSync('./data')
    ? fs__default['default'].readdirSync('./data').reduce((p, c) => {
        const content = JSON.parse(
          fs__default['default'].readFileSync('./data/' + c)
        );
        const collection = c.slice(0, -5);
        p[collection] = {};
        for (let endpoint in content) {
          p[collection][endpoint] = content[endpoint];
        }
        return p;
      }, {})
    : {};

  const actions = {
    get: (context, tokens, query, body) => {
      tokens = [context.params.collection, ...tokens];
      let responseData = data;
      for (let token of tokens) {
        if (responseData !== undefined) {
          responseData = responseData[token];
        }
      }
      return responseData;
    },
    post: (context, tokens, query, body) => {
      tokens = [context.params.collection, ...tokens];
      console.log('Request body:\n', body);

      // TODO handle collisions, replacement
      let responseData = data;
      for (let token of tokens) {
        if (responseData.hasOwnProperty(token) == false) {
          responseData[token] = {};
        }
        responseData = responseData[token];
      }

      const newId = uuid$1();
      responseData[newId] = Object.assign({}, body, { _id: newId });
      return responseData[newId];
    },
    put: (context, tokens, query, body) => {
      tokens = [context.params.collection, ...tokens];
      console.log('Request body:\n', body);

      let responseData = data;
      for (let token of tokens.slice(0, -1)) {
        if (responseData !== undefined) {
          responseData = responseData[token];
        }
      }
      if (
        responseData !== undefined &&
        responseData[tokens.slice(-1)] !== undefined
      ) {
        responseData[tokens.slice(-1)] = body;
      }
      return responseData[tokens.slice(-1)];
    },
    patch: (context, tokens, query, body) => {
      tokens = [context.params.collection, ...tokens];
      console.log('Request body:\n', body);

      let responseData = data;
      for (let token of tokens) {
        if (responseData !== undefined) {
          responseData = responseData[token];
        }
      }
      if (responseData !== undefined) {
        Object.assign(responseData, body);
      }
      return responseData;
    },
    delete: (context, tokens, query, body) => {
      tokens = [context.params.collection, ...tokens];
      let responseData = data;

      for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        if (responseData.hasOwnProperty(token) == false) {
          return null;
        }
        if (i == tokens.length - 1) {
          const body = responseData[token];
          delete responseData[token];
          return body;
        } else {
          responseData = responseData[token];
        }
      }
    },
  };

  const dataService = new Service_1();
  dataService.get(':collection', actions.get);
  dataService.post(':collection', actions.post);
  dataService.put(':collection', actions.put);
  dataService.patch(':collection', actions.patch);
  dataService.delete(':collection', actions.delete);

  var jsonstore = dataService.parseRequest;

  /*
   * This service requires storage and auth plugins
   */

  const { AuthorizationError: AuthorizationError$1 } = errors;

  const userService = new Service_1();

  userService.get('me', getSelf);
  userService.post('register', onRegister);
  userService.post('login', onLogin);
  userService.get('logout', onLogout);

  function getSelf(context, tokens, query, body) {
    if (context.user) {
      const result = Object.assign({}, context.user);
      delete result.hashedPassword;
      return result;
    } else {
      throw new AuthorizationError$1();
    }
  }

  function onRegister(context, tokens, query, body) {
    return context.auth.register(body);
  }

  function onLogin(context, tokens, query, body) {
    return context.auth.login(body);
  }

  function onLogout(context, tokens, query, body) {
    return context.auth.logout();
  }

  var users = userService.parseRequest;

  const { NotFoundError: NotFoundError$1, RequestError: RequestError$1 } =
    errors;

  var crud = {
    get,
    post,
    put,
    patch,
    delete: del,
  };

  function validateRequest(context, tokens, query) {
    /*
        if (context.params.collection == undefined) {
            throw new RequestError('Please, specify collection name');
        }
        */
    if (tokens.length > 1) {
      throw new RequestError$1();
    }
  }

  function parseWhere(query) {
    const operators = {
      '<=': (prop, value) => (record) => record[prop] <= JSON.parse(value),
      '<': (prop, value) => (record) => record[prop] < JSON.parse(value),
      '>=': (prop, value) => (record) => record[prop] >= JSON.parse(value),
      '>': (prop, value) => (record) => record[prop] > JSON.parse(value),
      '=': (prop, value) => (record) => record[prop] == JSON.parse(value),
      ' like ': (prop, value) => (record) =>
        record[prop].toLowerCase().includes(JSON.parse(value).toLowerCase()),
      ' in ': (prop, value) => (record) =>
        JSON.parse(`[${/\((.+?)\)/.exec(value)[1]}]`).includes(record[prop]),
    };
    const pattern = new RegExp(
      `^(.+?)(${Object.keys(operators).join('|')})(.+?)$`,
      'i'
    );

    try {
      let clauses = [query.trim()];
      let check = (a, b) => b;
      let acc = true;
      if (query.match(/ and /gi)) {
        // inclusive
        clauses = query.split(/ and /gi);
        check = (a, b) => a && b;
        acc = true;
      } else if (query.match(/ or /gi)) {
        // optional
        clauses = query.split(/ or /gi);
        check = (a, b) => a || b;
        acc = false;
      }
      clauses = clauses.map(createChecker);

      return (record) => clauses.map((c) => c(record)).reduce(check, acc);
    } catch (err) {
      throw new Error('Could not parse WHERE clause, check your syntax.');
    }

    function createChecker(clause) {
      let [match, prop, operator, value] = pattern.exec(clause);
      [prop, value] = [prop.trim(), value.trim()];

      return operators[operator.toLowerCase()](prop, value);
    }
  }

  function get(context, tokens, query, body) {
    validateRequest(context, tokens);

    let responseData;

    try {
      if (query.where) {
        responseData = context.storage
          .get(context.params.collection)
          .filter(parseWhere(query.where));
      } else if (context.params.collection) {
        responseData = context.storage.get(
          context.params.collection,
          tokens[0]
        );
      } else {
        // Get list of collections
        return context.storage.get();
      }

      if (query.sortBy) {
        const props = query.sortBy
          .split(',')
          .filter((p) => p != '')
          .map((p) => p.split(' ').filter((p) => p != ''))
          .map(([p, desc]) => ({ prop: p, desc: desc ? true : false }));

        // Sorting priority is from first to last, therefore we sort from last to first
        for (let i = props.length - 1; i >= 0; i--) {
          let { prop, desc } = props[i];
          responseData.sort(({ [prop]: propA }, { [prop]: propB }) => {
            if (typeof propA == 'number' && typeof propB == 'number') {
              return (propA - propB) * (desc ? -1 : 1);
            } else {
              return propA.localeCompare(propB) * (desc ? -1 : 1);
            }
          });
        }
      }

      if (query.offset) {
        responseData = responseData.slice(Number(query.offset) || 0);
      }
      const pageSize = Number(query.pageSize) || 10;
      if (query.pageSize) {
        responseData = responseData.slice(0, pageSize);
      }

      if (query.distinct) {
        const props = query.distinct.split(',').filter((p) => p != '');
        responseData = Object.values(
          responseData.reduce((distinct, c) => {
            const key = props.map((p) => c[p]).join('::');
            if (distinct.hasOwnProperty(key) == false) {
              distinct[key] = c;
            }
            return distinct;
          }, {})
        );
      }

      if (query.count) {
        return responseData.length;
      }

      if (query.select) {
        const props = query.select.split(',').filter((p) => p != '');
        responseData = Array.isArray(responseData)
          ? responseData.map(transform)
          : transform(responseData);

        function transform(r) {
          const result = {};
          props.forEach((p) => (result[p] = r[p]));
          return result;
        }
      }

      if (query.load) {
        const props = query.load.split(',').filter((p) => p != '');
        props.map((prop) => {
          const [propName, relationTokens] = prop.split('=');
          const [idSource, collection] = relationTokens.split(':');
          console.log(
            `Loading related records from "${collection}" into "${propName}", joined on "_id"="${idSource}"`
          );
          const storageSource =
            collection == 'users' ? context.protectedStorage : context.storage;
          responseData = Array.isArray(responseData)
            ? responseData.map(transform)
            : transform(responseData);

          function transform(r) {
            const seekId = r[idSource];
            const related = storageSource.get(collection, seekId);
            delete related.hashedPassword;
            r[propName] = related;
            return r;
          }
        });
      }
    } catch (err) {
      console.error(err);
      if (err.message.includes('does not exist')) {
        throw new NotFoundError$1();
      } else {
        throw new RequestError$1(err.message);
      }
    }

    context.canAccess(responseData);

    return responseData;
  }

  function post(context, tokens, query, body) {
    console.log('Request body:\n', body);

    validateRequest(context, tokens);
    if (tokens.length > 0) {
      throw new RequestError$1('Use PUT to update records');
    }
    context.canAccess(undefined, body);

    body._ownerId = context.user._id;
    let responseData;

    try {
      responseData = context.storage.add(context.params.collection, body);
    } catch (err) {
      throw new RequestError$1();
    }

    return responseData;
  }

  function put(context, tokens, query, body) {
    console.log('Request body:\n', body);

    validateRequest(context, tokens);
    if (tokens.length != 1) {
      throw new RequestError$1('Missing entry ID');
    }

    let responseData;
    let existing;

    try {
      existing = context.storage.get(context.params.collection, tokens[0]);
    } catch (err) {
      throw new NotFoundError$1();
    }

    context.canAccess(existing, body);

    try {
      responseData = context.storage.set(
        context.params.collection,
        tokens[0],
        body
      );
    } catch (err) {
      throw new RequestError$1();
    }

    return responseData;
  }

  function patch(context, tokens, query, body) {
    console.log('Request body:\n', body);

    validateRequest(context, tokens);
    if (tokens.length != 1) {
      throw new RequestError$1('Missing entry ID');
    }

    let responseData;
    let existing;

    try {
      existing = context.storage.get(context.params.collection, tokens[0]);
    } catch (err) {
      throw new NotFoundError$1();
    }

    context.canAccess(existing, body);

    try {
      responseData = context.storage.merge(
        context.params.collection,
        tokens[0],
        body
      );
    } catch (err) {
      throw new RequestError$1();
    }

    return responseData;
  }

  function del(context, tokens, query, body) {
    validateRequest(context, tokens);
    if (tokens.length != 1) {
      throw new RequestError$1('Missing entry ID');
    }

    let responseData;
    let existing;

    try {
      existing = context.storage.get(context.params.collection, tokens[0]);
    } catch (err) {
      throw new NotFoundError$1();
    }

    context.canAccess(existing);

    try {
      responseData = context.storage.delete(
        context.params.collection,
        tokens[0]
      );
    } catch (err) {
      throw new RequestError$1();
    }

    return responseData;
  }

  /*
   * This service requires storage and auth plugins
   */

  const dataService$1 = new Service_1();
  dataService$1.get(':collection', crud.get);
  dataService$1.post(':collection', crud.post);
  dataService$1.put(':collection', crud.put);
  dataService$1.patch(':collection', crud.patch);
  dataService$1.delete(':collection', crud.delete);

  var data$1 = dataService$1.parseRequest;

  const imgdata =
    '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Td4DLneAwSddMiRH8tMU8nng/Yy+KQsM3AKBNbe35j5OH4A0dbV8AxwcAqMFyl73eHd3e2//nmn29wOGi3Kv+RixSgAAEkxpVFh0WE1MOmNvbS5hZG9iZS54bXAAAAAAADw/eHBhY2tldCBiZWdpbj0i77u/IiBpZD0iVzVNME1wQ2VoaUh6cmVTek5UY3prYzlkIj8+Cjx4OnhtcG1ldGEgeG1sbnM6eD0iYWRvYmU6bnM6bWV0YS8iIHg6eG1wdGs9IlhNUCBDb3JlIDQuNC4wLUV4aXYyIj4KIDxyZGY6UkRGIHhtbG5zOnJkZj0iaHR0cDovL3d3dy53My5vcmcvMTk5OS8wMi8yMi1yZGYtc3ludGF4LW5zIyI+CiAgPHJkZjpEZXNjcmlwdGlvbiByZGY6YWJvdXQ9IiIKICAgIHhtbG5zOmlwdGNFeHQ9Imh0dHA6Ly9pcHRjLm9yZy9zdGQvSXB0YzR4bXBFeHQvMjAwOC0wMi0yOS8iCiAgICB4bWxuczp4bXBNTT0iaHR0cDovL25zLmFkb2JlLmNvbS94YXAvMS4wL21tLyIKICAgIHhtbG5zOnN0RXZ0PSJodHRwOi8vbnMuYWRvYmUuY29tL3hhcC8xLjAvc1R5cGUvUmVzb3VyY2VFdmVudCMiCiAgICB4bWxuczpwbHVzPSJodHRwOi8vbnMudXNlcGx1cy5vcmcvbGRmL3htcC8xLjAvIgogICAgeG1sbnM6R0lNUD0iaHR0cDovL3d3dy5naW1wLm9yZy94bXAvIgogICAgeG1sbnM6ZGM9Imh0dHA6Ly9wdXJsLm9yZy9kYy9lbGVtZW50cy8xLjEvIgogICAgeG1sbnM6cGhvdG9zaG9wPSJodHRwOi8vbnMuYWRvYmUuY29tL3Bob3Rvc2hvcC8xLjAvIgogICAgeG1sbnM6eG1wPSJodHRwOi8vbnMuYWRvYmUuY29tL3hhcC8xLjAvIgogICAgeG1sbnM6eG1wUmlnaHRzPSJodHRwOi8vbnMuYWRvYmUuY29tL3hhcC8xLjAvcmlnaHRzLyIKICAgeG1wTU06RG9jdW1lbnRJRD0iZ2ltcDpkb2NpZDpnaW1wOjdjZDM3NWM3LTcwNmItNDlkMy1hOWRkLWNmM2Q3MmMwY2I4ZCIKICAgeG1wTU06SW5zdGFuY2VJRD0ieG1wLmlpZDo2NGY2YTJlYy04ZjA5LTRkZTMtOTY3ZC05MTUyY2U5NjYxNTAiCiAgIHhtcE1NOk9yaWdpbmFsRG9jdW1lbnRJRD0ieG1wLmRpZDoxMmE1NzI5Mi1kNmJkLTRlYjQtOGUxNi1hODEzYjMwZjU0NWYiCiAgIEdJTVA6QVBJPSIyLjAiCiAgIEdJTVA6UGxhdGZvcm09IldpbmRvd3MiCiAgIEdJTVA6VGltZVN0YW1wPSIxNjEzMzAwNzI5NTMwNjQzIgogICBHSU1QOlZlcnNpb249IjIuMTAuMTIiCiAgIGRjOkZvcm1hdD0iaW1hZ2UvcG5nIgogICBwaG90b3Nob3A6Q3JlZGl0PSJHZXR0eSBJbWFnZXMvaVN0b2NrcGhvdG8iCiAgIHhtcDpDcmVhdG9yVG9vbD0iR0lNUCAyLjEwIgogICB4bXBSaWdodHM6V2ViU3RhdGVtZW50PSJodHRwczovL3d3dy5pc3RvY2twaG90by5jb20vbGVnYWwvbGljZW5zZS1hZ3JlZW1lbnQ/dXRtX21lZGl1bT1vcmdhbmljJmFtcDt1dG1fc291cmNlPWdvb2dsZSZhbXA7dXRtX2NhbXBhaWduPWlwdGN1cmwiPgogICA8aXB0Y0V4dDpMb2NhdGlvbkNyZWF0ZWQ+CiAgICA8cmRmOkJhZy8+CiAgIDwvaXB0Y0V4dDpMb2NhdGlvbkNyZWF0ZWQ+CiAgIDxpcHRjRXh0OkxvY2F0aW9uU2hvd24+CiAgICA8cmRmOkJhZy8+CiAgIDwvaXB0Y0V4dDpMb2NhdGlvblNob3duPgogICA8aXB0Y0V4dDpBcnR3b3JrT3JPYmplY3Q+CiAgICA8cmRmOkJhZy8+CiAgIDwvaXB0Y0V4dDpBcnR3b3JrT3JPYmplY3Q+CiAgIDxpcHRjRXh0OlJlZ2lzdHJ5SWQ+CiAgICA8cmRmOkJhZy8+CiAgIDwvaXB0Y0V4dDpSZWdpc3RyeUlkPgogICA8eG1wTU06SGlzdG9yeT4KICAgIDxyZGY6U2VxPgogICAgIDxyZGY6bGkKICAgICAgc3RFdnQ6YWN0aW9uPSJzYXZlZCIKICAgICAgc3RFdnQ6Y2hhbmdlZD0iLyIKICAgICAgc3RFdnQ6aW5zdGFuY2VJRD0ieG1wLmlpZDpjOTQ2M2MxMC05OWE4LTQ1NDQtYmRlOS1mNzY0ZjdhODJlZDkiCiAgICAgIHN0RXZ0OnNvZnR3YXJlQWdlbnQ9IkdpbXAgMi4xMCAoV2luZG93cykiCiAgICAgIHN0RXZ0OndoZW49IjIwMjEtMDItMTRUMTM6MDU6MjkiLz4KICAgIDwvcmRmOlNlcT4KICAgPC94bXBNTTpIaXN0b3J5PgogICA8cGx1czpJbWFnZVN1cHBsaWVyPgogICAgPHJkZjpTZXEvPgogICA8L3BsdXM6SW1hZ2VTdXBwbGllcj4KICAgPHBsdXM6SW1hZ2VDcmVhdG9yPgogICAgPHJkZjpTZXEvPgogICA8L3BsdXM6SW1hZ2VDcmVhdG9yPgogICA8cGx1czpDb3B5cmlnaHRPd25lcj4KICAgIDxyZGY6U2VxLz4KICAgPC9wbHVzOkNvcHlyaWdodE93bmVyPgogICA8cGx1czpMaWNlbnNvcj4KICAgIDxyZGY6U2VxPgogICAgIDxyZGY6bGkKICAgICAgcGx1czpMaWNlbnNvclVSTD0iaHR0cHM6Ly93d3cuaXN0b2NrcGhvdG8uY29tL3Bob3RvL2xpY2Vuc2UtZ20xMTUwMzQ1MzQxLT91dG1fbWVkaXVtPW9yZ2FuaWMmYW1wO3V0bV9zb3VyY2U9Z29vZ2xlJmFtcDt1dG1fY2FtcGFpZ249aXB0Y3VybCIvPgogICAgPC9yZGY6U2VxPgogICA8L3BsdXM6TGljZW5zb3I+CiAgIDxkYzpjcmVhdG9yPgogICAgPHJkZjpTZXE+CiAgICAgPHJkZjpsaT5WbGFkeXNsYXYgU2VyZWRhPC9yZGY6bGk+CiAgICA8L3JkZjpTZXE+CiAgIDwvZGM6Y3JlYXRvcj4KICAgPGRjOmRlc2NyaXB0aW9uPgogICAgPHJkZjpBbHQ+CiAgICAgPHJkZjpsaSB4bWw6bGFuZz0ieC1kZWZhdWx0Ij5TZXJ2aWNlIHRvb2xzIGljb24gb24gd2hpdGUgYmFja2dyb3VuZC4gVmVjdG9yIGlsbHVzdHJhdGlvbi48L3JkZjpsaT4KICAgIDwvcmRmOkFsdD4KICAgPC9kYzpkZXNjcmlwdGlvbj4KICA8L3JkZjpEZXNjcmlwdGlvbj4KIDwvcmRmOlJERj4KPC94OnhtcG1ldGE+CiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAKPD94cGFja2V0IGVuZD0idyI/PmWJCnkAAAAGYktHRAD/AP8A/6C9p5MAAAAJcEhZcwAALiMAAC4jAXilP3YAAAAHdElNRQflAg4LBR0CZnO/AAAARHRFWHRDb21tZW50AFNlcnZpY2UgdG9vbHMgaWNvbiBvbiB3aGl0ZSBiYWNrZ3JvdW5kLiBWZWN0b3IgaWxsdXN0cmF0aW9uLlwvEeIAAAMxSURBVHja7Z1bcuQwCEX7qrLQXlp2ynxNVWbK7dgWj3sl9JvYRhxACD369erW7UMzx/cYaychonAQvXM5ABYkpynoYIiEGdoQog6AYfywBrCxF4zNrX/7McBbuXJe8rXx/KBDULcGsMREzCbeZ4J6ME/9wVH5d95rogZp3npEgPLP3m2iUSGqXBJS5Dr6hmLm8kRuZABYti5TMaailV8LodNQwTTUWk4/WZk75l0kM0aZQdaZjMqkrQDAuyMVJWFjMB4GANXr0lbZBxQKr7IjI7QvVWkok/Jn5UHVh61CYPs+/i7eL9j3y/Au8WqoAIC34k8/9k7N8miLcaGWHwgjZXE/awyYX7h41wKMCskZM2HXAddDkTdglpSjz5bcKPbcCEKwT3+DhxtVpJvkEC7rZSgq32NMSBoXaCdiahDCKrND0fpX8oQlVsQ8IFQZ1VARdIF5wroekAjB07gsAgDUIbQHFENIDEX4CQANIVe8Iw/ASiACLXl28eaf579OPuBa9/mrELUYHQ1t3KHlZZnRcXb2/c7ygXIQZqjDMEzeSrOgCAhqYMvTUE+FKXoVxTxgk3DEPREjGzj3nAk/VaKyB9GVIu4oMyOlrQZgrBBEFG9PAZTfs3amYDGrP9Wl964IeFvtz9JFluIvlEvcdoXDOdxggbDxGwTXcxFRi/LdirKgZUBm7SUdJG69IwSUzAMWgOAq/4hyrZVaJISSNWHFVbEoCFEhyBrCtXS9L+so9oTy8wGqxbQDD350WTjNESVFEB5hdKzUGcV5QtYxVWR2Ssl4Mg9qI9u6FCBInJRXgfEEgtS9Cgrg7kKouq4mdcDNBnEHQvWFTdgdgsqP+MiluVeBM13ahx09AYSWi50gsF+I6vn7BmCEoHR3NBzkpIOw4+XdVBBGQUioblaZHbGlodtB+N/jxqwLX/x/NARfD8ADxTOCKIcwE4Lw0OIbguMYcGTlymEpHYLXIKx8zQEqIfS2lGJPaADFEBR/PMH79ErqtpnZmTBlvM4wgihPWDEEhXn1LISj50crNgfCp+dWHYQRCfb2zgfnBZmKGAyi914anK9Coi4LOMhoAn3uVtn+AGnLKxPUZnCuAAAAAElFTkSuQmCC';
  const img = Buffer.from(imgdata, 'base64');

  var favicon = (method, tokens, query, body) => {
    console.log('serving favicon...');
    const headers = {
      'Content-Type': 'image/png',
      'Content-Length': img.length,
    };
    let result = img;

    return {
      headers,
      result,
    };
  };

  var require$$0 =
    '<!DOCTYPE html>\r\n<html lang="en">\r\n<head>\r\n    <meta charset="UTF-8">\r\n    <meta http-equiv="X-UA-Compatible" content="IE=edge">\r\n    <meta name="viewport" content="width=device-width, initial-scale=1.0">\r\n    <title>SUPS Admin Panel</title>\r\n    <style>\r\n        * {\r\n            padding: 0;\r\n            margin: 0;\r\n        }\r\n\r\n        body {\r\n            padding: 32px;\r\n            font-size: 16px;\r\n        }\r\n\r\n        .layout::after {\r\n            content: \'\';\r\n            clear: both;\r\n            display: table;\r\n        }\r\n\r\n        .col {\r\n            display: block;\r\n            float: left;\r\n        }\r\n\r\n        p {\r\n            padding: 8px 16px;\r\n        }\r\n\r\n        table {\r\n            border-collapse: collapse;\r\n        }\r\n\r\n        caption {\r\n            font-size: 120%;\r\n            text-align: left;\r\n            padding: 4px 8px;\r\n            font-weight: bold;\r\n            background-color: #ddd;\r\n        }\r\n\r\n        table, tr, th, td {\r\n            border: 1px solid #ddd;\r\n        }\r\n\r\n        th, td {\r\n            padding: 4px 8px;\r\n        }\r\n\r\n        ul {\r\n            list-style: none;\r\n        }\r\n\r\n        .collection-list a {\r\n            display: block;\r\n            width: 120px;\r\n            padding: 4px 8px;\r\n            text-decoration: none;\r\n            color: black;\r\n            background-color: #ccc;\r\n        }\r\n        .collection-list a:hover {\r\n            background-color: #ddd;\r\n        }\r\n        .collection-list a:visited {\r\n            color: black;\r\n        }\r\n    </style>\r\n    <script type="module">\nimport { html, render } from \'https://unpkg.com/lit-html@1.3.0?module\';\nimport { until } from \'https://unpkg.com/lit-html@1.3.0/directives/until?module\';\n\nconst api = {\r\n    async get(url) {\r\n        return json(url);\r\n    },\r\n    async post(url, body) {\r\n        return json(url, {\r\n            method: \'POST\',\r\n            headers: { \'Content-Type\': \'application/json\' },\r\n            body: JSON.stringify(body)\r\n        });\r\n    }\r\n};\r\n\r\nasync function json(url, options) {\r\n    return await (await fetch(\'/\' + url, options)).json();\r\n}\r\n\r\nasync function getCollections() {\r\n    return api.get(\'data\');\r\n}\r\n\r\nasync function getRecords(collection) {\r\n    return api.get(\'data/\' + collection);\r\n}\r\n\r\nasync function getThrottling() {\r\n    return api.get(\'util/throttle\');\r\n}\r\n\r\nasync function setThrottling(throttle) {\r\n    return api.post(\'util\', { throttle });\r\n}\n\nasync function collectionList(onSelect) {\r\n    const collections = await getCollections();\r\n\r\n    return html`\r\n    <ul class="collection-list">\r\n        ${collections.map(collectionLi)}\r\n    </ul>`;\r\n\r\n    function collectionLi(name) {\r\n        return html`<li><a href="javascript:void(0)" @click=${(ev) => onSelect(ev, name)}>${name}</a></li>`;\r\n    }\r\n}\n\nasync function recordTable(collectionName) {\r\n    const records = await getRecords(collectionName);\r\n    const layout = getLayout(records);\r\n\r\n    return html`\r\n    <table>\r\n        <caption>${collectionName}</caption>\r\n        <thead>\r\n            <tr>${layout.map(f => html`<th>${f}</th>`)}</tr>\r\n        </thead>\r\n        <tbody>\r\n            ${records.map(r => recordRow(r, layout))}\r\n        </tbody>\r\n    </table>`;\r\n}\r\n\r\nfunction getLayout(records) {\r\n    const result = new Set([\'_id\']);\r\n    records.forEach(r => Object.keys(r).forEach(k => result.add(k)));\r\n\r\n    return [...result.keys()];\r\n}\r\n\r\nfunction recordRow(record, layout) {\r\n    return html`\r\n    <tr>\r\n        ${layout.map(f => html`<td>${JSON.stringify(record[f]) || html`<span>(missing)</span>`}</td>`)}\r\n    </tr>`;\r\n}\n\nasync function throttlePanel(display) {\r\n    const active = await getThrottling();\r\n\r\n    return html`\r\n    <p>\r\n        Request throttling: </span>${active}</span>\r\n        <button @click=${(ev) => set(ev, true)}>Enable</button>\r\n        <button @click=${(ev) => set(ev, false)}>Disable</button>\r\n    </p>`;\r\n\r\n    async function set(ev, state) {\r\n        ev.target.disabled = true;\r\n        await setThrottling(state);\r\n        display();\r\n    }\r\n}\n\n//import page from \'//unpkg.com/page/page.mjs\';\r\n\r\n\r\nfunction start() {\r\n    const main = document.querySelector(\'main\');\r\n    editor(main);\r\n}\r\n\r\nasync function editor(main) {\r\n    let list = html`<div class="col">Loading&hellip;</div>`;\r\n    let viewer = html`<div class="col">\r\n    <p>Select collection to view records</p>\r\n</div>`;\r\n    display();\r\n\r\n    list = html`<div class="col">${await collectionList(onSelect)}</div>`;\r\n    display();\r\n\r\n    async function display() {\r\n        render(html`\r\n        <section class="layout">\r\n            ${until(throttlePanel(display), html`<p>Loading</p>`)}\r\n        </section>\r\n        <section class="layout">\r\n            ${list}\r\n            ${viewer}\r\n        </section>`, main);\r\n    }\r\n\r\n    async function onSelect(ev, name) {\r\n        ev.preventDefault();\r\n        viewer = html`<div class="col">${await recordTable(name)}</div>`;\r\n        display();\r\n    }\r\n}\r\n\r\nstart();\n\n</script>\r\n</head>\r\n<body>\r\n    <main>\r\n        Loading&hellip;\r\n    </main>\r\n</body>\r\n</html>';

  const mode = process.argv[2] == '-dev' ? 'dev' : 'prod';

  const files = {
    index:
      mode == 'prod'
        ? require$$0
        : fs__default['default'].readFileSync('./client/index.html', 'utf-8'),
  };

  var admin = (method, tokens, query, body) => {
    const headers = {
      'Content-Type': 'text/html',
    };
    let result = '';

    const resource = tokens.join('/');
    if (resource && resource.split('.').pop() == 'js') {
      headers['Content-Type'] = 'application/javascript';

      files[resource] =
        files[resource] ||
        fs__default['default'].readFileSync('./client/' + resource, 'utf-8');
      result = files[resource];
    } else {
      result = files.index;
    }

    return {
      headers,
      result,
    };
  };

  /*
   * This service requires util plugin
   */

  const utilService = new Service_1();

  utilService.post('*', onRequest);
  utilService.get(':service', getStatus);

  function getStatus(context, tokens, query, body) {
    return context.util[context.params.service];
  }

  function onRequest(context, tokens, query, body) {
    Object.entries(body).forEach(([k, v]) => {
      console.log(`${k} ${v ? 'enabled' : 'disabled'}`);
      context.util[k] = v;
    });
    return '';
  }

  var util$1 = utilService.parseRequest;

  var services = {
    jsonstore,
    users,
    data: data$1,
    favicon,
    admin,
    util: util$1,
  };

  const { uuid: uuid$2 } = util;

  function initPlugin(settings) {
    const storage = createInstance(settings.seedData);
    const protectedStorage = createInstance(settings.protectedData);

    return function decoreateContext(context, request) {
      context.storage = storage;
      context.protectedStorage = protectedStorage;
    };
  }

  /**
   * Create storage instance and populate with seed data
   * @param {Object=} seedData Associative array with data. Each property is an object with properties in format {key: value}
   */
  function createInstance(seedData = {}) {
    const collections = new Map();

    // Initialize seed data from file
    for (let collectionName in seedData) {
      if (seedData.hasOwnProperty(collectionName)) {
        const collection = new Map();
        for (let recordId in seedData[collectionName]) {
          if (seedData.hasOwnProperty(collectionName)) {
            collection.set(recordId, seedData[collectionName][recordId]);
          }
        }
        collections.set(collectionName, collection);
      }
    }

    // Manipulation

    /**
     * Get entry by ID or list of all entries from collection or list of all collections
     * @param {string=} collection Name of collection to access. Throws error if not found. If omitted, returns list of all collections.
     * @param {number|string=} id ID of requested entry. Throws error if not found. If omitted, returns of list all entries in collection.
     * @return {Object} Matching entry.
     */
    function get(collection, id) {
      if (!collection) {
        return [...collections.keys()];
      }
      if (!collections.has(collection)) {
        throw new ReferenceError('Collection does not exist: ' + collection);
      }
      const targetCollection = collections.get(collection);
      if (!id) {
        const entries = [...targetCollection.entries()];
        let result = entries.map(([k, v]) => {
          return Object.assign(deepCopy(v), { _id: k });
        });
        return result;
      }
      if (!targetCollection.has(id)) {
        throw new ReferenceError('Entry does not exist: ' + id);
      }
      const entry = targetCollection.get(id);
      return Object.assign(deepCopy(entry), { _id: id });
    }

    /**
     * Add new entry to collection. ID will be auto-generated
     * @param {string} collection Name of collection to access. If the collection does not exist, it will be created.
     * @param {Object} data Value to store.
     * @return {Object} Original value with resulting ID under _id property.
     */
    function add(collection, data) {
      const record = assignClean({ _ownerId: data._ownerId }, data);

      let targetCollection = collections.get(collection);
      if (!targetCollection) {
        targetCollection = new Map();
        collections.set(collection, targetCollection);
      }
      let id = uuid$2();
      // Make sure new ID does not match existing value
      while (targetCollection.has(id)) {
        id = uuid$2();
      }

      record._createdOn = Date.now();
      targetCollection.set(id, record);
      return Object.assign(deepCopy(record), { _id: id });
    }

    /**
     * Replace entry by ID
     * @param {string} collection Name of collection to access. Throws error if not found.
     * @param {number|string} id ID of entry to update. Throws error if not found.
     * @param {Object} data Value to store. Record will be replaced!
     * @return {Object} Updated entry.
     */
    function set(collection, id, data) {
      if (!collections.has(collection)) {
        throw new ReferenceError('Collection does not exist: ' + collection);
      }
      const targetCollection = collections.get(collection);
      if (!targetCollection.has(id)) {
        throw new ReferenceError('Entry does not exist: ' + id);
      }

      const existing = targetCollection.get(id);
      const record = assignSystemProps(deepCopy(data), existing);
      record._updatedOn = Date.now();
      targetCollection.set(id, record);
      return Object.assign(deepCopy(record), { _id: id });
    }

    /**
     * Modify entry by ID
     * @param {string} collection Name of collection to access. Throws error if not found.
     * @param {number|string} id ID of entry to update. Throws error if not found.
     * @param {Object} data Value to store. Shallow merge will be performed!
     * @return {Object} Updated entry.
     */
    function merge(collection, id, data) {
      if (!collections.has(collection)) {
        throw new ReferenceError('Collection does not exist: ' + collection);
      }
      const targetCollection = collections.get(collection);
      if (!targetCollection.has(id)) {
        throw new ReferenceError('Entry does not exist: ' + id);
      }

      const existing = deepCopy(targetCollection.get(id));
      const record = assignClean(existing, data);
      record._updatedOn = Date.now();
      targetCollection.set(id, record);
      return Object.assign(deepCopy(record), { _id: id });
    }

    /**
     * Delete entry by ID
     * @param {string} collection Name of collection to access. Throws error if not found.
     * @param {number|string} id ID of entry to update. Throws error if not found.
     * @return {{_deletedOn: number}} Server time of deletion.
     */
    function del(collection, id) {
      if (!collections.has(collection)) {
        throw new ReferenceError('Collection does not exist: ' + collection);
      }
      const targetCollection = collections.get(collection);
      if (!targetCollection.has(id)) {
        throw new ReferenceError('Entry does not exist: ' + id);
      }
      targetCollection.delete(id);

      return { _deletedOn: Date.now() };
    }

    /**
     * Search in collection by query object
     * @param {string} collection Name of collection to access. Throws error if not found.
     * @param {Object} query Query object. Format {prop: value}.
     * @return {Object[]} Array of matching entries.
     */
    function query(collection, query) {
      if (!collections.has(collection)) {
        throw new ReferenceError('Collection does not exist: ' + collection);
      }
      const targetCollection = collections.get(collection);
      const result = [];
      // Iterate entries of target collection and compare each property with the given query
      for (let [key, entry] of [...targetCollection.entries()]) {
        let match = true;
        for (let prop in entry) {
          if (query.hasOwnProperty(prop)) {
            const targetValue = query[prop];
            // Perform lowercase search, if value is string
            if (
              typeof targetValue === 'string' &&
              typeof entry[prop] === 'string'
            ) {
              if (
                targetValue.toLocaleLowerCase() !==
                entry[prop].toLocaleLowerCase()
              ) {
                match = false;
                break;
              }
            } else if (targetValue != entry[prop]) {
              match = false;
              break;
            }
          }
        }

        if (match) {
          result.push(Object.assign(deepCopy(entry), { _id: key }));
        }
      }

      return result;
    }

    return { get, add, set, merge, delete: del, query };
  }

  function assignSystemProps(target, entry, ...rest) {
    const whitelist = ['_id', '_createdOn', '_updatedOn', '_ownerId'];
    for (let prop of whitelist) {
      if (entry.hasOwnProperty(prop)) {
        target[prop] = deepCopy(entry[prop]);
      }
    }
    if (rest.length > 0) {
      Object.assign(target, ...rest);
    }

    return target;
  }

  function assignClean(target, entry, ...rest) {
    const blacklist = ['_id', '_createdOn', '_updatedOn', '_ownerId'];
    for (let key in entry) {
      if (blacklist.includes(key) == false) {
        target[key] = deepCopy(entry[key]);
      }
    }
    if (rest.length > 0) {
      Object.assign(target, ...rest);
    }

    return target;
  }

  function deepCopy(value) {
    if (Array.isArray(value)) {
      return value.map(deepCopy);
    } else if (typeof value == 'object') {
      return [...Object.entries(value)].reduce(
        (p, [k, v]) => Object.assign(p, { [k]: deepCopy(v) }),
        {}
      );
    } else {
      return value;
    }
  }

  var storage = initPlugin;

  const {
    ConflictError: ConflictError$1,
    CredentialError: CredentialError$1,
    RequestError: RequestError$2,
  } = errors;

  function initPlugin$1(settings) {
    const identity = settings.identity;

    return function decorateContext(context, request) {
      context.auth = {
        register,
        login,
        logout,
      };

      const userToken = request.headers['x-authorization'];
      if (userToken !== undefined) {
        let user;
        const session = findSessionByToken(userToken);
        if (session !== undefined) {
          const userData = context.protectedStorage.get(
            'users',
            session.userId
          );
          if (userData !== undefined) {
            console.log('Authorized as ' + userData[identity]);
            user = userData;
          }
        }
        if (user !== undefined) {
          context.user = user;
        } else {
          throw new CredentialError$1('Invalid access token');
        }
      }

      function register(body) {
        if (
          body.hasOwnProperty(identity) === false ||
          body.hasOwnProperty('password') === false ||
          body[identity].length == 0 ||
          body.password.length == 0
        ) {
          throw new RequestError$2('Missing fields');
        } else if (
          context.protectedStorage.query('users', {
            [identity]: body[identity],
          }).length !== 0
        ) {
          throw new ConflictError$1(
            `A user with the same ${identity} already exists`
          );
        } else {
          const newUser = Object.assign({}, body, {
            [identity]: body[identity],
            hashedPassword: hash(body.password),
          });
          const result = context.protectedStorage.add('users', newUser);
          delete result.hashedPassword;

          const session = saveSession(result._id);
          result.accessToken = session.accessToken;

          return result;
        }
      }

      function login(body) {
        const targetUser = context.protectedStorage.query('users', {
          [identity]: body[identity],
        });
        if (targetUser.length == 1) {
          if (hash(body.password) === targetUser[0].hashedPassword) {
            const result = targetUser[0];
            delete result.hashedPassword;

            const session = saveSession(result._id);
            result.accessToken = session.accessToken;

            return result;
          } else {
            throw new CredentialError$1("Login or password don't match");
          }
        } else {
          throw new CredentialError$1("Login or password don't match");
        }
      }

      function logout() {
        if (context.user !== undefined) {
          const session = findSessionByUserId(context.user._id);
          if (session !== undefined) {
            context.protectedStorage.delete('sessions', session._id);
          }
        } else {
          throw new CredentialError$1('User session does not exist');
        }
      }

      function saveSession(userId) {
        let session = context.protectedStorage.add('sessions', { userId });
        const accessToken = hash(session._id);
        session = context.protectedStorage.set(
          'sessions',
          session._id,
          Object.assign({ accessToken }, session)
        );
        return session;
      }

      function findSessionByToken(userToken) {
        return context.protectedStorage.query('sessions', {
          accessToken: userToken,
        })[0];
      }

      function findSessionByUserId(userId) {
        return context.protectedStorage.query('sessions', { userId })[0];
      }
    };
  }

  const secret = 'This is not a production server';

  function hash(string) {
    const hash = crypto__default['default'].createHmac('sha256', secret);
    hash.update(string);
    return hash.digest('hex');
  }

  var auth = initPlugin$1;

  function initPlugin$2(settings) {
    const util = {
      throttle: false,
    };

    return function decoreateContext(context, request) {
      context.util = util;
    };
  }

  var util$2 = initPlugin$2;

  /*
   * This plugin requires auth and storage plugins
   */

  const {
    RequestError: RequestError$3,
    ConflictError: ConflictError$2,
    CredentialError: CredentialError$2,
    AuthorizationError: AuthorizationError$2,
  } = errors;

  function initPlugin$3(settings) {
    const actions = {
      GET: '.read',
      POST: '.create',
      PUT: '.update',
      PATCH: '.update',
      DELETE: '.delete',
    };
    const rules = Object.assign(
      {
        '*': {
          '.create': ['User'],
          '.update': ['Owner'],
          '.delete': ['Owner'],
        },
      },
      settings.rules
    );

    return function decorateContext(context, request) {
      // special rules (evaluated at run-time)
      const get = (collectionName, id) => {
        return context.storage.get(collectionName, id);
      };
      const isOwner = (user, object) => {
        return user._id == object._ownerId;
      };
      context.rules = {
        get,
        isOwner,
      };
      const isAdmin = request.headers.hasOwnProperty('x-admin');

      context.canAccess = canAccess;

      function canAccess(data, newData) {
        const user = context.user;
        const action = actions[request.method];
        let { rule, propRules } = getRule(
          action,
          context.params.collection,
          data
        );

        if (Array.isArray(rule)) {
          rule = checkRoles(rule, data);
        } else if (typeof rule == 'string') {
          rule = !!eval(rule);
        }
        if (!rule && !isAdmin) {
          throw new CredentialError$2();
        }
        propRules.map((r) => applyPropRule(action, r, user, data, newData));
      }

      function applyPropRule(action, [prop, rule], user, data, newData) {
        // NOTE: user needs to be in scope for eval to work on certain rules
        if (typeof rule == 'string') {
          rule = !!eval(rule);
        }

        if (rule == false) {
          if (action == '.create' || action == '.update') {
            delete newData[prop];
          } else if (action == '.read') {
            delete data[prop];
          }
        }
      }

      function checkRoles(roles, data, newData) {
        if (roles.includes('Guest')) {
          return true;
        } else if (!context.user && !isAdmin) {
          throw new AuthorizationError$2();
        } else if (roles.includes('User')) {
          return true;
        } else if (context.user && roles.includes('Owner')) {
          return context.user._id == data._ownerId;
        } else {
          return false;
        }
      }
    };

    function getRule(action, collection, data = {}) {
      let currentRule = ruleOrDefault(true, rules['*'][action]);
      let propRules = [];

      // Top-level rules for the collection
      const collectionRules = rules[collection];
      if (collectionRules !== undefined) {
        // Top-level rule for the specific action for the collection
        currentRule = ruleOrDefault(currentRule, collectionRules[action]);

        // Prop rules
        const allPropRules = collectionRules['*'];
        if (allPropRules !== undefined) {
          propRules = ruleOrDefault(
            propRules,
            getPropRule(allPropRules, action)
          );
        }

        // Rules by record id
        const recordRules = collectionRules[data._id];
        if (recordRules !== undefined) {
          currentRule = ruleOrDefault(currentRule, recordRules[action]);
          propRules = ruleOrDefault(
            propRules,
            getPropRule(recordRules, action)
          );
        }
      }

      return {
        rule: currentRule,
        propRules,
      };
    }

    function ruleOrDefault(current, rule) {
      return rule === undefined || rule.length === 0 ? current : rule;
    }

    function getPropRule(record, action) {
      const props = Object.entries(record)
        .filter(([k]) => k[0] != '.')
        .filter(([k, v]) => v.hasOwnProperty(action))
        .map(([k, v]) => [k, v[action]]);

      return props;
    }
  }

  var rules = initPlugin$3;

  var identity = 'email';
  var protectedData = {
    users: {
      '78d8bbbb-31fa-4208-bfd2-5360a62c0d02': {
        email: 'assia@abv.bg',
        username: 'Assia Ilieva',
        hashedPassword:
          '83313014ed3e2391aa1332615d2f053cf5c1bfe05ca1cbcb5582443822df6eb1',
      },
      '35c62d76-8152-4626-8712-eeb96381bea8': {
        email: 'peter@abv.bg',
        username: 'Peter',
        hashedPassword:
          '83313014ed3e2391aa1332615d2f053cf5c1bfe05ca1cbcb5582443822df6eb1',
      },
      '847ec027-f659-4086-8032-5173e2f9c93a': {
        email: 'george@abv.bg',
        username: 'George',
        hashedPassword:
          '83313014ed3e2391aa1332615d2f053cf5c1bfe05ca1cbcb5582443822df6eb1',
      },
      '60f0cf0b-34b0-4abd-9769-8c42f830dffc': {
        email: 'admin@abv.bg',
        username: 'Admin',
        hashedPassword:
          'fac7060c3e17e6f151f247eacb2cd5ae80b8c36aedb8764e18a41bbdc16aa302',
      },
    },
    sessions: {},
  };
  var seedData = {
    recipes: {
      '8f46934e-d35f-438e-bf0e-91596c16035b': {
        _ownerId: '78d8bbbb-31fa-4208-bfd2-5360a62c0d02',
        recipeName: 'Spaghetty Carbonara',
        recipeType: 'Main Course',
        preparationTime: 45,
        imageURL:
          'https://anitalianinmykitchen.com/wp-content/uploads/2021/03/carbonara-photo-.jpg',
        description:
          'Spaghetti carbonara is a classic Italian pasta dish with a creamy sauce of eggs, cheese, pancetta or bacon, and black pepper.',
        ingredients:
          '4 servings spaghetti, 150g pancetta or bacon - diced, 2 large eggs, 50g grated Parmesan cheese, 2 cloves garlic, minced, 2 tablespoons olive oil, salt to taste, freshly ground black pepper to taste',
        instructions:
          'Cook the spaghetti according to package instructions. Sauté the pancetta or bacon with garlic in olive oil until crispy. In a bowl, whisk eggs and Parmesan cheese together. Toss the hot spaghetti with the pancetta, then mix in the egg mixture off the heat to create a creamy sauce. Season with salt and pepper.',
        _createdOn: 1722362834291,
        _id: '8f46934e-d35f-438e-bf0e-91596c16035b',
      },
      'b9530fed-3654-438e-b5f9-19fe04aed8f8': {
        _ownerId: '78d8bbbb-31fa-4208-bfd2-5360a62c0d02',
        recipeName: 'Crème Brûlée',
        recipeType: 'Dessert',
        preparationTime: 60,
        imageURL:
          'https://brunchandbatter.com/wp-content/uploads/2022/06/Yogurt-Brulee-FI.jpg',
        description:
          'Crème brûlée is a classic French dessert consisting of a rich, creamy custard base topped with a crisp layer of caramelized sugar.',
        ingredients:
          '500ml heavy cream, 1 vanilla bean or 1 tablespoon vanilla extract, 5 large egg yolks, 100g granulated sugar, 2 tablespoons brown sugar (for caramelizing)',
        instructions:
          'Preheat your oven to 160°C (325°F). Heat the heavy cream and vanilla bean (split and scraped) in a saucepan until just simmering. Remove from heat and let it infuse for 10 minutes. If using vanilla extract, add it after heating.\nWhisk the egg yolks and granulated sugar together until pale and slightly thickened. Slowly pour the hot cream into the egg yolk mixture, whisking constantly to avoid curdling. Strain the mixture through a fine-mesh sieve into a clean bowl or pitcher. Divide the custard mixture among ramekins and place them in a baking dish. Pour hot water into the dish halfway up the sides of the ramekins to create a water bath. Bake for 30-40 minutes, or until the custards are set but still slightly wobbly in the center. Remove from the oven and let cool to room temperature. Refrigerate for at least 2 hours or overnight. Before serving, sprinkle a thin layer of brown sugar on top of each custard. Use a kitchen torch to caramelize the sugar until it forms a crispy, golden-brown crust. Serve immediately.',
        _createdOn: 1722373410922,
        _id: 'b9530fed-3654-438e-b5f9-19fe04aed8f8',
      },
      '2909a3a8-eb62-41c9-9209-6ca058fa2b61': {
        _ownerId: '35c62d76-8152-4626-8712-eeb96381bea8',
        recipeName: 'Zucchini Fritters',
        recipeType: 'Appetizer',
        preparationTime: 60,
        imageURL:
          'https://www.healthygffamily.com/wp-content/uploads/2019/07/8D52E1C3-D91E-47E0-8FE7-A582A57F4D52-scaled.jpg',
        description:
          'Zucchini fritters are crispy, golden-brown patties made from grated zucchini mixed with flour, eggs, cheese, and herbs.',
        ingredients:
          '2 medium zucchinis grated, 1/2 cup all-purpose flour, 1 large egg, 1/2 cup grated cheese (such as Parmesan or cheddar), 2 tablespoons chopped fresh herbs (such as parsley or dill), 2 cloves garlic  minced, Salt to taste, freshly ground black pepper to taste, 2 tablespoons olive oil (for frying)',
        instructions:
          'Grate the zucchinis and place them in a colander. Sprinkle with a little salt and let them sit for about 10 minutes to draw out excess moisture. Squeeze out as much liquid as possible using a clean kitchen towel or paper towels. In a bowl, combine the grated zucchini, flour, egg, grated cheese, chopped herbs, minced garlic, salt, and pepper. Mix well until everything is evenly combined. Heat olive oil in a skillet over medium heat. Scoop spoonfuls of the zucchini mixture into the skillet and flatten them slightly to form patties. Cook the fritters for about 3-4 minutes on each side, or until they are golden brown and crispy. Remove from the skillet and drain on paper towels. Serve warm with a side of yogurt or sour cream if desired.',
        _createdOn: 1722374259449,
        _id: '2909a3a8-eb62-41c9-9209-6ca058fa2b61',
      },
      '882ed39e-580b-49e9-b2a3-bdf1e8b521ae': {
        _ownerId: '35c62d76-8152-4626-8712-eeb96381bea8',
        recipeName: 'Apple Pie',
        recipeType: 'Dessert',
        preparationTime: 150,
        imageURL:
          'https://jessicainthekitchen.com/wp-content/uploads/2021/09/Vegan-Apple-Pie-14-500x375.jpg',
        description:
          'Apple pie is a classic dessert featuring a buttery, flaky crust filled with tender, spiced apples.',
        ingredients:
          '2 1/2 cups all-purpose flour, 1 cup unsalted butter (cold and cubed), 1/4 cup granulated sugar, 1/4 teaspoon salt, 6-7 medium apples (such as Granny Smith or Honeycrisp), peeled, cored, and sliced, 3/4 cup granulated sugar, 1/4 cup brown sugar, 1 tablespoon lemon juice, 1 teaspoon ground cinnamon, 1/4 teaspoon ground nutmeg, 1/4 teaspoon ground allspice, 1 tablespoon all-purpose flour or cornstarch (for thickening), 1 egg (for egg wash, optional), 1 tablespoon milk (for egg wash, optional)',
        instructions:
          'To prepare apple pie, first make the dough by cutting cold butter into flour, sugar, and salt until crumbly, then add water to form a dough. Chill the dough, then roll out and fit into a pie dish. Mix sliced apples with sugar, brown sugar, lemon juice, spices, and flour or cornstarch, then pour into the pie crust. Cover with a top crust or lattice, seal edges, and brush with egg wash if desired. Bake at 220°C (425°F) for 45-50 minutes, until the crust is golden and the filling is bubbly. Let cool before serving',
        _createdOn: 1722373747011,
        _id: '882ed39e-580b-49e9-b2a3-bdf1e8b521ae',
      },
      '7c301f53-f215-449c-8c59-6914a942fc16': {
        _ownerId: '78d8bbbb-31fa-4208-bfd2-5360a62c0d02',
        recipeName: 'Mushroom Risotto',
        recipeType: 'Appetizer',
        preparationTime: 60,
        imageURL:
          'https://www.allrecipes.com/thmb/9d8yV77PRL3wbRwcpAIxtZPdi5Q=/0x512/filters:no_upscale():max_bytes(150000):strip_icc()/85389-gourmet-mushroom-risotto-DDMFS-4x3-a8a80a8deb064c6a8f15452b808a0258.jpg',
        description:
          'Mushroom risotto is a creamy Italian dish made with Arborio rice cooked slowly in a flavorful broth, combined with sautéed porcini mushrooms, onions, and garlic.',
        ingredients:
          '300g Arborio rice, 200g fresh or dried porcini mushrooms, 1 small onion, finely chopped, 2 cloves garlic, minced, 100ml white wine, 1 liter chicken or vegetable broth, 50g grated Parmesan cheese, 2 tablespoons olive oil, 2 tablespoons butter, salt to taste, freshly ground black pepper to taste, fresh parsley, chopped (optional, for garnish)',
        instructions:
          'Sauté onions and garlic in olive oil and butter, then add Arborio rice and cook for a few minutes. Deglaze with white wine, then gradually add warm broth, stirring frequently. Incorporate sautéed porcini mushrooms and cook until the rice is creamy and tender. Finish with Parmesan cheese, season with salt and pepper, and garnish with fresh parsley if desired.',
        _createdOn: 1722373152588,
        _id: '7c301f53-f215-449c-8c59-6914a942fc16',
      },
      'd81e4069-7d31-4743-b59b-0d21bc5059b7': {
        _ownerId: '847ec027-f659-4086-8032-5173e2f9c93a',
        recipeName: 'Meat Balls in Tomato Sauce',
        recipeType: 'Main Course',
        preparationTime: 70,
        imageURL:
          'https://www.allrecipes.com/thmb/bA6K66Wfj2oyXQtnZob8FP-UFU8=/1500x0/filters:no_upscale():max_bytes(150000):strip_icc()/220854-chef-johns-italian-meatballs-DDMFS-beauty-4x3-BG-31732-f527165240e34fb081a5290e47d580d0.jpg',
        description:
          'Meatballs in tomato sauce is a comforting dish featuring tender, seasoned ground beef meatballs simmered in a rich, flavorful tomato sauce with herbs.',
        ingredients:
          '500g ground beef, 1 small onion, finely chopped, 2 cloves garlic minced, 1 egg, 50g breadcrumbs, 2 tablespoons chopped fresh parsley, salt to taste, black pepper to taste, 500ml canned crushed tomatoes, 1 tablespoon tomato paste, 1 teaspoon dried oregano, 1 teaspoon dried basil, 2 tablespoons olive oil',
        instructions:
          'Preheat your oven to 200°C (400°F). Combine ground beef, chopped onion, minced garlic, egg, breadcrumbs, parsley, salt, and pepper in a bowl. Mix well and form into meatballs. Place the meatballs on a baking sheet and bake for about 20 minutes, or until cooked through. In a pan, heat olive oil over medium heat. Add tomato paste and cook for 1-2 minutes. Add crushed tomatoes, oregano, and basil. Simmer for 10 minutes. Add the baked meatballs to the tomato sauce and simmer for 10 minutes to let the flavors meld. Serve the meatballs and sauce over pasta, rice, or with bread.',
        _createdOn: 1722363576603,
        _id: 'd81e4069-7d31-4743-b59b-0d21bc5059b7',
      },

      '5948c5e7-02a8-455f-aeae-2ade057ed4b8': {
        _ownerId: '847ec027-f659-4086-8032-5173e2f9c93a',
        recipeName: 'Bruschetta',
        recipeType: 'Appetizer',
        preparationTime: 30,
        imageURL:
          'https://www.howtocook.recipes/wp-content/uploads/2021/09/Bruschetta-recipe-500x500.jpg',
        description:
          'A classic Italian appetizer featuring toasted bread topped with a mixture of diced tomatoes, garlic, basil, olive oil, and balsamic vinegar.',
        ingredients:
          '1 loaf of Italian bread or baguette - sliced, 4 ripe tomatoes - diced, 2 cloves garlic - minced, 2 tablespoons fresh basil - chopped, 3 tablespoons olive oil, 1 tablespoon balsamic vinegar, salt to taste, freshly ground black pepper to taste',
        instructions:
          'Preheat your oven to 200°C (400°F). Arrange the bread slices on a baking sheet and toast them in the oven for about 5-7 minutes or until golden and crispy. In a bowl, combine the diced tomatoes, minced garlic, chopped basil, olive oil, balsamic vinegar, salt, and black pepper. Spoon the tomato mixture onto the toasted bread slices. Serve immediately.',
        _createdOn: 1722364429383,
        _id: '5948c5e7-02a8-455f-aeae-2ade057ed4b8',
      },

      '59c16686-08b2-4b45-8a8a-0ccf702e1056': {
        _ownerId: '35c62d76-8152-4626-8712-eeb96381bea8',
        recipeName: 'Tiramisu',
        recipeType: 'Dessert',
        preparationTime: 40,
        imageURL:
          'https://bakewithzoha.com/wp-content/uploads/2023/12/hot-chocolate-tiramisu-featured.jpg',
        description:
          'Rich Italian dessert made of layers of coffee-soaked ladyfingers, mascarpone cheese, and cocoa powder.',
        ingredients:
          '1 packet ladyfingers, 500g mascarpone, 3 eggs, 3 table spoons sugar, 500ml strong coffee, 50ml marsala',
        instructions:
          'Brew and cool the coffee, then mix in the marsala. Separate the eggs and beat the yolks with sugar until creamy; fold in mascarpone until smooth. Whip the egg whites until stiff and gently fold into the mascarpone mixture. Dip ladyfingers briefly in the coffee mixture, then layer them in a dish. Spread half of the mascarpone mixture over the ladyfingers, then repeat layers. Chill for at least 4 hours, and dust with cocoa powder before serving.',
        _createdOn: 1733597017657,
        _id: '59c16686-08b2-4b45-8a8a-0ccf702e1056',
      },
      'c2fb0f02-8c03-435d-9709-b121b09bd286': {
        _ownerId: '78d8bbbb-31fa-4208-bfd2-5360a62c0d02',
        recipeName: 'Pepper Steak',
        recipeType: 'Main Course',
        preparationTime: 50,
        imageURL:
          'https://img.freepik.com/free-photo/juicy-steak-medium-rare-beef-with-spices_2829-5642.jpg?uid=R106433200&ga=GA1.1.394476995.1723047083&semt=ais_hybrid',
        description:
          'Pepper steak is a flavorful dish featuring beef steaks seasoned with a mix of crushed black, green, and white peppercorns, then seared to perfection.',
        ingredients:
          '4 beef steaks (about 600g), 1 tablespoon black peppercorns - crushed, 1 tablespoon green peppercorns - crushed, 1 tablespoon white peppercorns - crushed, 2 tablespoons butter, 1 tablespoon olive oil, 1 small onion - finely chopped, 2 cloves garlic - finely chopped, 100ml white wine, 200ml beef broth, 100ml heavy cream, salt to taste',
        instructions:
          'Season the steaks with crushed peppercorns and sear in butter and olive oil until cooked to the desired doneness. In the same pan, sauté onions and garlic, then deglaze with white wine, add beef broth and cream, simmer until thickened, and serve over the steaks',
        _createdOn: 1733683417657,
        _id: 'c2fb0f02-8c03-435d-9709-b121b09bd286',
      },
      '0b1a8593-a87f-46d1-b0c2-17eaec95afec': {
        _ownerId: '9409e503-74c2-4d99-8004-eaf23dc7005e',
        recipeName: 'French Soup',
        recipeType: 'Soup',
        preparationTime: 50,
        imageURL:
          'https://img.freepik.com/free-photo/delicious-melted-cheese-snacks_23-2149274868.jpg?uid=R106433200&ga=GA1.1.394476995.1723047083&semt=ais_hybrid',
        description:
          'A comforting and flavorful French soup, combining caramelized onions, rich broth, and a hint of wine, topped with crusty bread and melted cheese for a perfect balance of textures and tastes',
        ingredients:
          'Onions,  Butter,  Olive oil, Beef or vegetable broth,  White wine (optional), Thyme, Bay leaf, Salt and pepper, French baguette, Gruyère or Swiss cheese',
        instructions:
          'Sauté sliced onions in butter and olive oil until golden. Add broth, wine (optional), thyme, and bay leaf. Simmer for 20-30 minutes. Season with salt and pepper to taste. Toast baguette slices and top with grated cheese. Pour soup into bowls, place a toast on top, and broil until cheese is melted.Bon appétit!',
        _createdOn: 1733769817657,
        _id: '0b1a8593-a87f-46d1-b0c2-17eaec95afec',
      },
      '8cbeb771-d0c3-4e1e-a84a-079874c99fef': {
        recipeName: 'Raspberry Cheesecake',
        recipeType: 'Dessert',
        preparationTime: 80,
        imageURL:
          'https://img.freepik.com/free-photo/front-close-view-delicious-pancakes-with-fresh-raspberries-light-table_140725-130937.jpg?uid=R106433200&ga=GA1.1.394476995.1723047083&semt=ais_hybrid',
        description:
          'A creamy and tangy cheesecake with a fresh raspberry swirl',
        ingredients:
          '200g digestive biscuits, 100g melted butter, 400g cream cheese, 200ml sour cream, 100g powdered sugar, 1 tsp vanilla extract, 150g fresh raspberries, 50g sugar',
        instructions:
          'Crush the biscuits and mix with melted butter, press into the base of a pan. Blend cream cheese, sour cream, powdered sugar, and vanilla until smooth. Spread the mixture over the biscuit base. Blend raspberries and sugar, swirl into the cheesecake mixture. Chill for 4 hours before serving. Enjoy!',
        _createdOn: 1733817037881,
        _ownerId: '26241f0b-ac41-49cb-99d9-80ee77284678',
        _updatedOn: 1733817159183,
        _id: '8cbeb771-d0c3-4e1e-a84a-079874c99fef',
      },
      'ccc36827-b03e-4921-a12f-c1c227bd13b1': {
        _ownerId: '78d8bbbb-31fa-4208-bfd2-5360a62c0d02',
        recipeName: 'Tzatziki',
        recipeType: 'Appetizer',
        preparationTime: 30,
        imageURL:
          'https://img.freepik.com/free-photo/traditional-mixed-soup-ovdukh-plain-youghurt-cucumber-spring-onions-dill-basil-egg-beef-garlic-top-view_141793-3252.jpg?uid=R106433200&ga=GA1.1.394476995.1723047083&semt=ais_hybrid',
        description:
          ' A refreshing Greek yogurt dip with cucumber, garlic, and herbs.',
        ingredients:
          '1 cup Greek yogurt, 1 cucumber, grated and drained, 2 cloves garlic, minced, 1 tbsp olive oil, 1 tbsp fresh dill, chopped, 1 tbsp lemon juice, Salt and pepper to taste.',
        instructions:
          '1. In a bowl, combine the Greek yogurt, grated cucumber, minced garlic, olive oil, dill, and lemon juice. \n2. Mix until smooth and season with salt and pepper to taste. \n3. Chill in the fridge for at least 30 minutes before serving. \n4. Serve as a dip with pita bread or fresh vegetables.',
        _createdOn: 1733823973185,
        _id: 'ccc36827-b03e-4921-a12f-c1c227bd13b1',
      },
    },
    comments: {
      '8cc65b8f-9273-4558-a6b0-251b48a7202f': {
        _ownerId: '35c62d76-8152-4626-8712-eeb96381bea8',
        recipeId: '882ed39e-580b-49e9-b2a3-bdf1e8b521ae',
        text: 'I shared this recipe because it is one of my favorites. I have known it since I lived in the US.',
        _createdOn: 1733655130569,
        _id: '8cc65b8f-9273-4558-a6b0-251b48a7202f',
        author: {
          email: 'peter@abv.bg',
          username: 'Peter',
          _id: '35c62d76-8152-4626-8712-eeb96381bea8',
        },
      },
      '5575d857-b993-484d-bbe2-934378b42a87': {
        _ownerId: '78d8bbbb-31fa-4208-bfd2-5360a62c0d02',
        recipeId: '882ed39e-580b-49e9-b2a3-bdf1e8b521ae',
        text: "I've tried it and I recommend it. It is nice, easy and great!",
        _createdOn: 1733655205192,
        _id: '5575d857-b993-484d-bbe2-934378b42a87',
        author: {
          email: 'assia@abv.bg',
          username: 'Assia Ilieva',
          _id: '78d8bbbb-31fa-4208-bfd2-5360a62c0d02',
        },
      },
      'df34c2af-09d3-4bb4-a945-a1ed5bb066e1': {
        _ownerId: '78d8bbbb-31fa-4208-bfd2-5360a62c0d02',
        recipeId: 'b9530fed-3654-438e-b5f9-19fe04aed8f8',
        text: "Well, the recipe is not easy, maybe that's why Peter didn't like it.",
        _createdOn: 1733654807662,
        _id: 'df34c2af-09d3-4bb4-a945-a1ed5bb066e1',
        author: {
          email: 'assia@abv.bg',
          username: 'Assia Ilieva',
          _id: '78d8bbbb-31fa-4208-bfd2-5360a62c0d02',
        },
      },
      '5af4ae6b-6b20-4803-bb5c-6bc0bd26f1c5': {
        _ownerId: '78d8bbbb-31fa-4208-bfd2-5360a62c0d02',
        recipeId: '2909a3a8-eb62-41c9-9209-6ca058fa2b61',
        text: 'Yes, this is one of the most famous Greek dishes. You can find it in every Greek restaurant',
        _createdOn: 1733654553248,
        _id: '5af4ae6b-6b20-4803-bb5c-6bc0bd26f1c5',
        author: {
          email: 'assia@abv.bg',
          username: 'Assia Ilieva',
          _id: '78d8bbbb-31fa-4208-bfd2-5360a62c0d02',
        },
      },
      '20644b49-9571-479c-9dc2-5563bf782d24': {
        _ownerId: '35c62d76-8152-4626-8712-eeb96381bea8',
        recipeId: '2909a3a8-eb62-41c9-9209-6ca058fa2b61',
        text: 'I think this is a Greek dish. It is very delicious! ',
        _createdOn: 1733654271006,
        _id: '20644b49-9571-479c-9dc2-5563bf782d24',
        author: {
          email: 'peter@abv.bg',
          username: 'Peter',
          _id: '35c62d76-8152-4626-8712-eeb96381bea8',
        },
      },
      '31b49c34-429c-4001-98b0-7301a4edd7e0': {
        _ownerId: '78d8bbbb-31fa-4208-bfd2-5360a62c0d02',
        recipeId: '8f46934e-d35f-438e-bf0e-91596c16035b',
        text: 'Perfect recipe',
        _createdOn: 1733651552115,
        _id: '31b49c34-429c-4001-98b0-7301a4edd7e0',
        author: {
          email: 'assia@abv.bg',
          username: 'Assia Ilieva',
          _id: '78d8bbbb-31fa-4208-bfd2-5360a62c0d02',
        },
      },
      'effc8520-1950-4e01-b76b-71c32ae6a3c9': {
        _ownerId: '35c62d76-8152-4626-8712-eeb96381bea8',
        recipeId: '8f46934e-d35f-438e-bf0e-91596c16035b',
        text: 'This is my favorite recipe. I am cooking this dish every week!',
        _createdOn: 1733653131695,
        _id: 'effc8520-1950-4e01-b76b-71c32ae6a3c9',
        author: {
          email: 'peter@abv.bg',
          username: 'Peter',
          _id: '35c62d76-8152-4626-8712-eeb96381bea8',
        },
      },
      'b9530fed-3654-438e-b5f9-19fe04aed8f8': {
        _ownerId: '35c62d76-8152-4626-8712-eeb96381bea8',
        recipeId: 'b9530fed-3654-438e-b5f9-19fe04aed8f8',
        text: "I didn't liked this recipe",
        _createdOn: 1733653532048,
        _id: 'c62c5cef-6d06-4a93-95a3-55339c190e37',
        author: {
          email: 'peter@abv.bg',
          username: 'Peter',
          _id: '35c62d76-8152-4626-8712-eeb96381bea8',
        },
      },
    },
    tips: {
      'f555385f-2d73-4ca6-8927-b5d42fcf792f': {
        _ownerId: '78d8bbbb-31fa-4208-bfd2-5360a62c0d02',
        heading: 'How to fry eggs',
        tipType: 'Cooking Techniques',
        description: 'The best way to fry eggs - Spanish method',
        content:
          'I cook my fried eggs according to the Spanish method. You fry them in a good amount of oil and baste the whites frequently with the hot oil. It makes the egg whites puff up and crisp at the edges.',
        imageURL: '/images/technique.png',
        _createdOn: 1722855844808,
        _id: 'f555385f-2d73-4ca6-8927-b5d42fcf792f',
      },
      'f5a169d5-8430-4c9a-ae8f-05beb07ae6a0': {
        _ownerId: '35c62d76-8152-4626-8712-eeb96381bea8',
        heading: 'How to peel eggs easily',
        tipType: 'Kitchen hacks',
        description: 'Read this and you will peel an egg for seconds',
        content:
          'You probably already know that adding a dash of vinegar to egg poaching water helps coagulate the white. But did you know that adding a dash of vinegar to the water when boiling eggs helps the shell peel off more easily? Say goodbye to piles of tiny egg shell shards.',
        imageURL: '/images/hack.png',
        _createdOn: 1722857460368,
        _id: 'f5a169d5-8430-4c9a-ae8f-05beb07ae6a0',
      },
      'b40df538-b0f8-479a-a91b-9792fda9bcd7': {
        _ownerId: '78d8bbbb-31fa-4208-bfd2-5360a62c0d02',
        heading: 'Freeze Liquids in Useable Portions',
        tipType: 'Kitchen hacks',
        description: 'Save time and  supplies with this hack',
        content:
          'You can freeze wine in ice cube trays and store them in the freezer, ready to be pulled out one at a time and added to pan sauces and stews, saving you from having to open a whole bottle every time a recipe calls for some wine.\n\nSimilarly, if you make yourself a large batch of stock, freeze it in convenient portion sizes in the freezer—ice cube trays and half-pint deli containers are great for this—then transfer them to a plastic freezer bag to be pulled out and used whenever you need fresh stock.',
        imageURL: '/images/hack.png',
        _createdOn: 1722857757522,
        _id: 'b40df538-b0f8-479a-a91b-9792fda9bcd7',
      },
      '8df8e11c-b33d-430b-8352-82e1a29f11d0': {
        _ownerId: '35c62d76-8152-4626-8712-eeb96381bea8',
        heading: 'Read the Recipe Thoroughly',
        tipType: 'Cooking Techniques',
        description: 'Before you begin your cooking',
        content:
          "Take time to read the entire recipe from start to finish so you know what to expect before you begin cooking. Familiarise yourself with the ingredients you'll need for the entire recipe, along with the likely measurements and cooking techniques. Not only will you get a vision of how to create the dish, but you'll also avoid being caught off-guard with any surprises or mistakes along the way.",
        imageURL: '/images/technique.png',
        _createdOn: 1722858056481,
        _id: '8df8e11c-b33d-430b-8352-82e1a29f11d0',
      },
    },
    catches: {
      '07f260f4-466c-4607-9a33-f7273b24f1b4': {
        _ownerId: '35c62d76-8152-4626-8712-eeb96381bea8',
        angler: 'Paulo Admorim',
        weight: 636,
        species: 'Atlantic Blue Marlin',
        location: 'Vitoria, Brazil',
        bait: 'trolled pink',
        captureTime: 80,
        _createdOn: 1614760714812,
        _id: '07f260f4-466c-4607-9a33-f7273b24f1b4',
      },
      'bdabf5e9-23be-40a1-9f14-9117b6702a9d': {
        _ownerId: '847ec027-f659-4086-8032-5173e2f9c93a',
        angler: 'John Does',
        weight: 554,
        species: 'Atlantic Blue Marlin',
        location: 'Buenos Aires, Argentina',
        bait: 'trolled pink',
        captureTime: 120,
        _createdOn: 1614760782277,
        _id: 'bdabf5e9-23be-40a1-9f14-9117b6702a9d',
      },
    },
    furniture: {},
    orders: {},
    movies: {
      '1240549d-f0e0-497e-ab99-eb8f703713d7': {
        _ownerId: '847ec027-f659-4086-8032-5173e2f9c93a',
        title: 'Black Widow',
        description:
          'Natasha Romanoff aka Black Widow confronts the darker parts of her ledger when a dangerous conspiracy with ties to her past arises. Comes on the screens 2020.',
        img: 'https://miro.medium.com/max/735/1*akkAa2CcbKqHsvqVusF3-w.jpeg',
        _createdOn: 1614935055353,
        _id: '1240549d-f0e0-497e-ab99-eb8f703713d7',
      },
      '143e5265-333e-4150-80e4-16b61de31aa0': {
        _ownerId: '847ec027-f659-4086-8032-5173e2f9c93a',
        title: 'Wonder Woman 1984',
        description:
          'Diana must contend with a work colleague and businessman, whose desire for extreme wealth sends the world down a path of destruction, after an ancient artifact that grants wishes goes missing.',
        img: 'https://pbs.twimg.com/media/ETINgKwWAAAyA4r.jpg',
        _createdOn: 1614935181470,
        _id: '143e5265-333e-4150-80e4-16b61de31aa0',
      },
      'a9bae6d8-793e-46c4-a9db-deb9e3484909': {
        _ownerId: '35c62d76-8152-4626-8712-eeb96381bea8',
        title: 'Top Gun 2',
        description:
          "After more than thirty years of service as one of the Navy's top aviators, Pete Mitchell is where he belongs, pushing the envelope as a courageous test pilot and dodging the advancement in rank that would ground him.",
        img: 'https://i.pinimg.com/originals/f2/a4/58/f2a458048757bc6914d559c9e4dc962a.jpg',
        _createdOn: 1614935268135,
        _id: 'a9bae6d8-793e-46c4-a9db-deb9e3484909',
      },
    },
    likes: {},
    ideas: {
      '833e0e57-71dc-42c0-b387-0ce0caf5225e': {
        _ownerId: '847ec027-f659-4086-8032-5173e2f9c93a',
        title: 'Best Pilates Workout To Do At Home',
        description:
          'Lorem ipsum dolor, sit amet consectetur adipisicing elit. Minima possimus eveniet ullam aspernatur corporis tempore quia nesciunt nostrum mollitia consequatur. At ducimus amet aliquid magnam nulla sed totam blanditiis ullam atque facilis corrupti quidem nisi iusto saepe, consectetur culpa possimus quos? Repellendus, dicta pariatur! Delectus, placeat debitis error dignissimos nesciunt magni possimus quo nulla, fuga corporis maxime minus nihil doloremque aliquam quia recusandae harum. Molestias dolorum recusandae commodi velit cum sapiente placeat alias rerum illum repudiandae? Suscipit tempore dolore autem, neque debitis quisquam molestias officia hic nesciunt? Obcaecati optio fugit blanditiis, explicabo odio at dicta asperiores distinctio expedita dolor est aperiam earum! Molestias sequi aliquid molestiae, voluptatum doloremque saepe dignissimos quidem quas harum quo. Eum nemo voluptatem hic corrupti officiis eaque et temporibus error totam numquam sequi nostrum assumenda eius voluptatibus quia sed vel, rerum, excepturi maxime? Pariatur, provident hic? Soluta corrupti aspernatur exercitationem vitae accusantium ut ullam dolor quod!',
        img: './images/best-pilates-youtube-workouts-2__medium_4x3.jpg',
        _createdOn: 1615033373504,
        _id: '833e0e57-71dc-42c0-b387-0ce0caf5225e',
      },
      '247efaa7-8a3e-48a7-813f-b5bfdad0f46c': {
        _ownerId: '847ec027-f659-4086-8032-5173e2f9c93a',
        title: '4 Eady DIY Idea To Try!',
        description:
          'Similique rem culpa nemo hic recusandae perspiciatis quidem, quia expedita, sapiente est itaque optio enim placeat voluptates sit, fugit dignissimos tenetur temporibus exercitationem in quis magni sunt vel. Corporis officiis ut sapiente exercitationem consectetur debitis suscipit laborum quo enim iusto, labore, quod quam libero aliquid accusantium! Voluptatum quos porro fugit soluta tempore praesentium ratione dolorum impedit sunt dolores quod labore laudantium beatae architecto perspiciatis natus cupiditate, iure quia aliquid, iusto modi esse!',
        img: './images/brightideacropped.jpg',
        _createdOn: 1615033452480,
        _id: '247efaa7-8a3e-48a7-813f-b5bfdad0f46c',
      },
      'b8608c22-dd57-4b24-948e-b358f536b958': {
        _ownerId: '35c62d76-8152-4626-8712-eeb96381bea8',
        title: 'Dinner Recipe',
        description:
          'Consectetur labore et corporis nihil, officiis tempora, hic ex commodi sit aspernatur ad minima? Voluptas nesciunt, blanditiis ex nulla incidunt facere tempora laborum ut aliquid beatae obcaecati quidem reprehenderit consequatur quis iure natus quia totam vel. Amet explicabo quidem repellat unde tempore et totam minima mollitia, adipisci vel autem, enim voluptatem quasi exercitationem dolor cum repudiandae dolores nostrum sit ullam atque dicta, tempora iusto eaque! Rerum debitis voluptate impedit corrupti quibusdam consequatur minima, earum asperiores soluta. A provident reiciendis voluptates et numquam totam eveniet! Dolorum corporis libero dicta laborum illum accusamus ullam?',
        img: './images/dinner.jpg',
        _createdOn: 1615033491967,
        _id: 'b8608c22-dd57-4b24-948e-b358f536b958',
      },
    },
    catalog: {
      '53d4dbf5-7f41-47ba-b485-43eccb91cb95': {
        _ownerId: '35c62d76-8152-4626-8712-eeb96381bea8',
        make: 'Table',
        model: 'Swedish',
        year: 2015,
        description: 'Medium table',
        price: 235,
        img: './images/table.png',
        material: 'Hardwood',
        _createdOn: 1615545143015,
        _id: '53d4dbf5-7f41-47ba-b485-43eccb91cb95',
      },
      'f5929b5c-bca4-4026-8e6e-c09e73908f77': {
        _ownerId: '847ec027-f659-4086-8032-5173e2f9c93a',
        make: 'Sofa',
        model: 'ES-549-M',
        year: 2018,
        description: 'Three-person sofa, blue',
        price: 1200,
        img: './images/sofa.jpg',
        material: 'Frame - steel, plastic; Upholstery - fabric',
        _createdOn: 1615545572296,
        _id: 'f5929b5c-bca4-4026-8e6e-c09e73908f77',
      },
      'c7f51805-242b-45ed-ae3e-80b68605141b': {
        _ownerId: '847ec027-f659-4086-8032-5173e2f9c93a',
        make: 'Chair',
        model: 'Bright Dining Collection',
        year: 2017,
        description: 'Dining chair',
        price: 180,
        img: './images/chair.jpg',
        material: 'Wood laminate; leather',
        _createdOn: 1615546332126,
        _id: 'c7f51805-242b-45ed-ae3e-80b68605141b',
      },
    },
    teams: {
      '34a1cab1-81f1-47e5-aec3-ab6c9810efe1': {
        _ownerId: '35c62d76-8152-4626-8712-eeb96381bea8',
        name: 'Storm Troopers',
        logoUrl: '/assets/atat.png',
        description: "These ARE the droids we're looking for",
        _createdOn: 1615737591748,
        _id: '34a1cab1-81f1-47e5-aec3-ab6c9810efe1',
      },
      'dc888b1a-400f-47f3-9619-07607966feb8': {
        _ownerId: '847ec027-f659-4086-8032-5173e2f9c93a',
        name: 'Team Rocket',
        logoUrl: '/assets/rocket.png',
        description: "Gotta catch 'em all!",
        _createdOn: 1615737655083,
        _id: 'dc888b1a-400f-47f3-9619-07607966feb8',
      },
      '733fa9a1-26b6-490d-b299-21f120b2f53a': {
        _ownerId: '847ec027-f659-4086-8032-5173e2f9c93a',
        name: 'Minions',
        logoUrl: '/assets/hydrant.png',
        description:
          'Friendly neighbourhood jelly beans, helping evil-doers succeed.',
        _createdOn: 1615737688036,
        _id: '733fa9a1-26b6-490d-b299-21f120b2f53a',
      },
    },
    members: {
      'cc9b0a0f-655d-45d7-9857-0a61c6bb2c4d': {
        _ownerId: '35c62d76-8152-4626-8712-eeb96381bea8',
        teamId: '34a1cab1-81f1-47e5-aec3-ab6c9810efe1',
        status: 'member',
        _createdOn: 1616236790262,
        _updatedOn: 1616236792930,
      },
      '61a19986-3b86-4347-8ca4-8c074ed87591': {
        _ownerId: '847ec027-f659-4086-8032-5173e2f9c93a',
        teamId: 'dc888b1a-400f-47f3-9619-07607966feb8',
        status: 'member',
        _createdOn: 1616237188183,
        _updatedOn: 1616237189016,
      },
      '8a03aa56-7a82-4a6b-9821-91349fbc552f': {
        _ownerId: '847ec027-f659-4086-8032-5173e2f9c93a',
        teamId: '733fa9a1-26b6-490d-b299-21f120b2f53a',
        status: 'member',
        _createdOn: 1616237193355,
        _updatedOn: 1616237195145,
      },
      '9be3ac7d-2c6e-4d74-b187-04105ab7e3d6': {
        _ownerId: '35c62d76-8152-4626-8712-eeb96381bea8',
        teamId: 'dc888b1a-400f-47f3-9619-07607966feb8',
        status: 'member',
        _createdOn: 1616237231299,
        _updatedOn: 1616237235713,
      },
      '280b4a1a-d0f3-4639-aa54-6d9158365152': {
        _ownerId: '60f0cf0b-34b0-4abd-9769-8c42f830dffc',
        teamId: 'dc888b1a-400f-47f3-9619-07607966feb8',
        status: 'member',
        _createdOn: 1616237257265,
        _updatedOn: 1616237278248,
      },
      'e797fa57-bf0a-4749-8028-72dba715e5f8': {
        _ownerId: '60f0cf0b-34b0-4abd-9769-8c42f830dffc',
        teamId: '34a1cab1-81f1-47e5-aec3-ab6c9810efe1',
        status: 'member',
        _createdOn: 1616237272948,
        _updatedOn: 1616237293676,
      },
    },
  };
  var rules$1 = {
    users: {
      '.create': false,
      '.read': ['Owner'],
      '.update': false,
      '.delete': false,
    },
    members: {
      '.update': "isOwner(user, get('teams', data.teamId))",
      '.delete':
        "isOwner(user, get('teams', data.teamId)) || isOwner(user, data)",
      '*': {
        teamId: {
          '.update': 'newData.teamId = data.teamId',
        },
        status: {
          '.create': "newData.status = 'pending'",
        },
      },
    },
  };
  var settings = {
    identity: identity,
    protectedData: protectedData,
    seedData: seedData,
    rules: rules$1,
  };

  const plugins = [
    storage(settings),
    auth(settings),
    util$2(),
    rules(settings),
  ];

  const server = http__default['default'].createServer(
    requestHandler(plugins, services)
  );

  const port = 3030;
  server.listen(port);
  console.log(
    `Server started on port ${port}. You can make requests to http://localhost:${port}/`
  );
  console.log(`Admin panel located at http://localhost:${port}/admin`);

  var softuniPracticeServer = {};

  return softuniPracticeServer;
});
