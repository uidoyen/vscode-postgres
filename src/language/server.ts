import {
  IPCMessageReader, IPCMessageWriter, createConnection, IConnection,
  TextDocuments, TextDocument, InitializeResult,
  Diagnostic, DiagnosticSeverity, TextDocumentPositionParams,
  CompletionItem, CompletionItemKind,
  SignatureHelp, SignatureInformation, ParameterInformation
} from 'vscode-languageserver';
import { Client } from 'pg';
import * as fs from 'fs';
import { Validator } from './validator';
import { IConnection as IDBConnection } from '../common/IConnection';
import { BackwardIterator } from '../common/backwordIterator';

export interface ISetConnection { 
  connection: IDBConnection
  documentUri?: string;
}

export interface ExplainResults {
  rowCount: number;
  command: string;
  rows?: any[];
  fields?: any[];
}

export interface DBField {
  attisdropped: boolean,
  attname: string,
  attnum: number,
  attrelid: string,
  data_type: string
}

export interface DBTable {
  tablename: string,
  is_table: boolean,
  columns: DBField[]
}

export interface DBFunctionsRaw {
  schema: string
  name: string
  result_type: string
  argument_types: string
  type: string,
  description: string
}

export interface DBFunctionArgList {
  args: string[],
  description: string
}

export interface DBFunction {
  schema: string
  name: string
  result_type: string
  overloads: DBFunctionArgList[],
  type: string
}

let tableCache: DBTable[] = [];
let functionCache: DBFunction[] = [];
let keywordCache: string[] = [];
let databaseCache: string[] = [];

/**
 * To Debug the language server
 * 
 * 1. Start the extension via F5
 * 2. Under vscode Debug pane, switch to "Attach to Language Server"
 * 3. F5
  */

let connection: IConnection = createConnection(new IPCMessageReader(process), new IPCMessageWriter(process));
let dbConnection: Client = null,
    dbConnOptions: IDBConnection = null;

console.log = connection.console.log.bind(connection.console);
console.error = connection.console.error.bind(connection.console);

let documents: TextDocuments = new TextDocuments();
documents.listen(connection);

let shouldSendDiagnosticRelatedInformation: boolean = false;

connection.onInitialize((_params) : InitializeResult => {
  shouldSendDiagnosticRelatedInformation = _params.capabilities && _params.capabilities.textDocument && _params.capabilities.textDocument.publishDiagnostics && _params.capabilities.textDocument.publishDiagnostics.relatedInformation;
  return {
    capabilities: {
      textDocumentSync: documents.syncKind,
      completionProvider: {
        triggerCharacters: [' ', '.', '"']
      },
      signatureHelpProvider: {
        triggerCharacters: ['(', ',']
      }
    }
  }
});

/*
.dP"Y8 888888 888888 88   88 88""Yb     8888b.  88""Yb      dP""b8    db     dP""b8 88  88 888888 
`Ybo." 88__     88   88   88 88__dP      8I  Yb 88__dP     dP   `"   dPYb   dP   `" 88  88 88__   
o.`Y8b 88""     88   Y8   8P 88"""       8I  dY 88""Yb     Yb       dP__Yb  Yb      888888 88""   
8bodP' 888888   88   `YbodP' 88         8888Y"  88oodP      YboodP dP""""Yb  YboodP 88  88 888888 
*/
function dbConnectionEnded() {
  dbConnection = null;
  tableCache = [];
  functionCache = [];
  keywordCache = [];
  databaseCache = [];
}

async function setupDBConnection(connectionOptions: IDBConnection, uri: string): Promise<void> {
  if (connectionOptions) {
    // dbConnection = await Database.createConnection(conn);
    if (connectionOptions.certPath && fs.existsSync(connectionOptions.certPath)) {
      connectionOptions.ssl = {
        ca: fs.readFileSync(connectionOptions.certPath).toString()
      }
    }

    if (!connectionOptions.database) {
      connectionOptions = {
        label: connectionOptions.label, 
        host: connectionOptions.host,
        user: connectionOptions.user,
        password: connectionOptions.password,
        port: connectionOptions.port,
        database: 'postgres',
        multipleStatements: connectionOptions.multipleStatements,
        certPath: connectionOptions.certPath,
        ssl: connectionOptions.ssl
      };
    }
    
    dbConnection = new Client(connectionOptions);
    await dbConnection.connect();
    dbConnection.on('end', dbConnectionEnded);

    loadCompletionCache(connectionOptions);

    if (uri) {
      let document = documents.get(uri);
      if (document && document.languageId === 'postgres') {
        validateTextDocument(document);
      }
    }
  }
  dbConnOptions = connectionOptions;
}

async function loadCompletionCache(connectionOptions: IDBConnection) {
  if (!connectionOptions || !dbConnection) return;
  // setup database caches for functions, tables, and fields
  try {
    if (connectionOptions.database) {
      /*
      SELECT tablename as name, true as is_table FROM pg_tables WHERE schemaname not in ('information_schema', 'pg_catalog')
      union all
      SELECT viewname as name, false as is_table FROM pg_views WHERE schemaname not in ('information_schema', 'pg_catalog') order by name;
      */
      let tablesAndColumns = await dbConnection.query(`
        SELECT
          tbl.tablename,
          tbl.is_table,
          json_agg(a) as columns
        FROM
          (
            SELECT tablename, true as is_table FROM pg_tables WHERE schemaname not in ('information_schema', 'pg_catalog')
            union all
            SELECT viewname as tablename, false as is_table FROM pg_views WHERE schemaname not in ('information_schema', 'pg_catalog')
          ) as tbl
          LEFT JOIN (
            SELECT
              attrelid,
              attname,
              format_type(atttypid, atttypmod) as data_type,
              attnum,
              attisdropped
            FROM
              pg_attribute
          ) as a ON (a.attrelid = tbl.tablename::regclass AND a.attnum > 0 AND NOT a.attisdropped)
        GROUP BY tablename, is_table;
        `);
      tableCache = tablesAndColumns.rows;
    }
  }
  catch (err) {
    console.log(err);
  }

  try {
    let functions = await dbConnection.query(`
      SELECT n.nspname as "schema",
        p.proname as "name",
        d.description,
        pg_catalog.pg_get_function_result(p.oid) as "result_type",
        pg_catalog.pg_get_function_arguments(p.oid) as "argument_types",
      CASE
        WHEN p.proisagg THEN 'agg'
        WHEN p.proiswindow THEN 'window'
        WHEN p.prorettype = 'pg_catalog.trigger'::pg_catalog.regtype THEN 'trigger'
        ELSE 'normal'
      END as "type"
      FROM pg_catalog.pg_proc p
          LEFT JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
          LEFT JOIN pg_catalog.pg_description d ON p.oid = d.objoid
      WHERE pg_catalog.pg_function_is_visible(p.oid)
        AND p.prorettype <> 'pg_catalog.trigger'::pg_catalog.regtype
            AND n.nspname <> 'information_schema'
      ORDER BY 1, 2, 4;
      `);
    
    functions.rows.forEach((fn:DBFunctionsRaw) => {
      // return new ColumnNode(this.connection, this.table, column);
      let existing = functionCache.find(f => f.name === fn.name);
      if (!existing) {
        existing = {
          name: fn.name,
          schema: fn.schema,
          result_type: fn.result_type,
          type: fn.type,
          overloads: []
        }
        functionCache.push(existing);
      }
      let args = fn.argument_types.split(',').filter(a => a).map<string>(a => a.trim());
      existing.overloads.push({args, description: fn.description});
    });
  }
  catch (err) {
    console.log(err);
  }

  try {
    let keywords = await dbConnection.query(`select * from pg_get_keywords();`);
    keywordCache = keywords.rows.map<string>(rw => rw.word.toLocaleUpperCase());
  }
  catch (err) {
    console.log(err);
  }

  try {
    let databases = await dbConnection.query(`SELECT datname FROM pg_database WHERE datistemplate = false;`);
    databaseCache = databases.rows.map<string>(rw => rw.datname);
  }
  catch (err) {
    console.log(err);
  }
}

connection.onRequest('set_connection', async function() {
  let newConnection: ISetConnection = arguments[0];
  if (!dbConnOptions && !newConnection.connection) {
    // neither has a connection - just exist
    return;
  }
  if (dbConnOptions && newConnection.connection && newConnection.connection.host === dbConnOptions.host && newConnection.connection.database === dbConnOptions.database && newConnection.connection.port === dbConnOptions.port && newConnection.connection.user === dbConnOptions.user) {
    // same connection - just exit
    return;
  }

  if (dbConnection) {
    // kill the connection first
    await dbConnection.end();
  }
  setupDBConnection(newConnection.connection, newConnection.documentUri)
  .catch(err => {
    console.log(err.message)
  });
});

/*
 dP"Yb  88   88 888888 88""Yb Yb  dP     Yb    dP    db    88     88 8888b.     db    888888 88  dP"Yb  88b 88 
dP   Yb 88   88 88__   88__dP  YbdP       Yb  dP    dPYb   88     88  8I  Yb   dPYb     88   88 dP   Yb 88Yb88 
Yb b dP Y8   8P 88""   88"Yb    8P         YbdP    dP__Yb  88  .o 88  8I  dY  dP__Yb    88   88 Yb   dP 88 Y88 
 `"YoYo `YbodP' 888888 88  Yb  dP           YP    dP""""Yb 88ood8 88 8888Y"  dP""""Yb   88   88  YbodP  88  Y8 
*/
documents.onDidOpen((change) => {
  validateTextDocument(change.document);
});

documents.onDidChangeContent((change) => {
  validateTextDocument(change.document);
});

var _NL = '\n'.charCodeAt(0);
async function validateTextDocument(textDocument: TextDocument): Promise<void> {
  let diagnostics: Diagnostic[] = [];
  // parse and find issues
  if (dbConnection) {
    let sqlText = textDocument.getText();
    if (!sqlText) {
      connection.sendDiagnostics({uri: textDocument.uri, diagnostics});
      return;
    }
    for (let sql of Validator.prepare_sql(sqlText)) {
      if (!sql.statement) continue;
      let errColumnMod = 0;
      if (sql.statement.trim().toUpperCase().startsWith('EXPLAIN ')) {
        let match = sql.statement.match(/\s*?EXPLAIN\s/gi);
        if (match) {
          for (let i = 0; i < match[0].length; i++) {
            let ch = match[0].charCodeAt(i);
            errColumnMod++;
            if (ch === _NL) {
              errColumnMod = 1;
              sql.line++;
            }
          }
          sql.statement = sql.statement.replace(/\s*?EXPLAIN\s/gi, '');
        }
      }
      try {
        const results = await dbConnection.query(`EXPLAIN ${sql.statement}`);
      }
      catch(err) {
        // can use err.position (string)
        // corresponds to full position in query "EXPLAIN ${sql.statement}"
        // need to parse out where in parsed statement and lines that it is
        let errPosition = parseInt(err.position) - 9 + errColumnMod; // removes "EXPLAIN " and turn to zero based
        let errLine = 0;
        while (errPosition > sql.lines[errLine].length) {
          errPosition -= (sql.lines[errLine].length + 1);
          errLine++;
        }
        // should have the line - and column
        // find next space after position
        let spacePos = errPosition;
        if (errPosition < sql.lines[errLine].length) {
          spacePos = sql.lines[errLine].indexOf(' ', errPosition);
          if (spacePos < 0) {
            spacePos = sql.lines[errLine].length;
          }
        }
        if (errLine === 0) {
          errPosition += sql.column; // add the column back in - only for first line
        }
        diagnostics.push({
          severity: DiagnosticSeverity.Error,
          range: {
            start: { line: sql.line + errLine, character: errPosition },
            end: {line: sql.line + errLine, character: spacePos }
          },
          message: err.message,
          source: dbConnOptions.host
        });
      }
    }
  }
  connection.sendDiagnostics({uri: textDocument.uri, diagnostics});
}

/*
 dP""b8  dP"Yb  8888b.  888888      dP""b8  dP"Yb  8b    d8 88""Yb 88     888888 888888 88  dP"Yb  88b 88 
dP   `" dP   Yb  8I  Yb 88__       dP   `" dP   Yb 88b  d88 88__dP 88     88__     88   88 dP   Yb 88Yb88 
Yb      Yb   dP  8I  dY 88""       Yb      Yb   dP 88YbdP88 88"""  88  .o 88""     88   88 Yb   dP 88 Y88 
 YboodP  YbodP  8888Y"  888888      YboodP  YbodP  88 YY 88 88     88ood8 888888   88   88  YbodP  88  Y8 
*/
connection.onCompletion((e: any): CompletionItem[] => {
  let items: CompletionItem[] = [];
  let scenarioFound = false;

  let document = documents.get(e.textDocument.uri);
  if (!document) return items;

  let iterator = new BackwardIterator(document, e.position.character - 1, e.position.line);
  
  // // look back and grab the text immediately prior to match to table
  // let line = document.getText({
  //   start: {line: e.position.line, character: 0},
  //   end: {line: e.position.line, character: e.position.character}
  // });

  // let prevSpace = line.lastIndexOf(' ', e.position.character - 1) + 1;
  // let keyword = line.substring(prevSpace, e.position.character - 1);

  if (e.context.triggerCharacter === '"') {
    let startingQuotedIdent = iterator.isFowardDQuote();
    if (!startingQuotedIdent) return items;

    iterator.next(); // get passed the starting quote
    if (iterator.isNextPeriod()) {
      // probably a field - get the ident
      let ident = iterator.readIdent();
      let isQuotedIdent = false;
      if (ident.match(/^\".*?\"$/)) {
        isQuotedIdent = true;
        ident = fixQuotedIdent(ident);
      }
      let table = tableCache.find(tbl => {
        return (isQuotedIdent && tbl.tablename === ident) || (!isQuotedIdent && tbl.tablename.toLocaleLowerCase() == ident.toLocaleLowerCase());
      });

      if (!table) return items;
      table.columns.forEach(field => {
        items.push({
          label: field.attname,
          kind: CompletionItemKind.Property,
          detail: field.data_type
        });
      });
    } else {
      // probably a table - list the tables
      tableCache.forEach(table => {
        items.push({
          label: table.tablename,
          kind: CompletionItemKind.Class
        });
      });
    }
    return items;
  }

  if (e.context.triggerCharacter === '.') {
    let ident = iterator.readIdent();
    let isQuotedIdent = false;
    if (ident.match(/^\".*?\"$/)) {
      isQuotedIdent = true;
      ident = fixQuotedIdent(ident);
    }

    let table = tableCache.find(tbl => {
      return (isQuotedIdent && tbl.tablename === ident) || (!isQuotedIdent && tbl.tablename.toLocaleLowerCase() == ident.toLocaleLowerCase());
    });

    if (table) {
      table.columns.forEach(field => {
        items.push({
          label: field.attname,
          kind: CompletionItemKind.Property,
          detail: field.data_type
        });
      });
    }
    return items;
  }

  if (!scenarioFound) {
    tableCache.forEach(table => {
      items.push({
        label: table.tablename,
        kind: table.is_table ? CompletionItemKind.Class : CompletionItemKind.Interface
      });
      table.columns.forEach(field => {
        let foundItem = items.find(i => i.label === field.attname && i.kind === CompletionItemKind.Property && i.detail === field.data_type);
        if (foundItem) {
          foundItem.documentation += `, ${table.tablename}`;
        } else {
          items.push({
            label: field.attname,
            kind: CompletionItemKind.Field,
            detail: field.data_type,
            documentation: table.tablename
          });
        }
      });
    });
    functionCache.forEach(fn => {
      items.push({
        label: fn.name,
        kind: CompletionItemKind.Function,
        detail: fn.result_type,
        documentation: fn.overloads[0].description
      });
    });
    keywordCache.forEach(keyword => {
      items.push({
        label: keyword,
        kind: CompletionItemKind.Keyword
      });
    });
    databaseCache.forEach(database => {
      items.push({
        label: database,
        kind: CompletionItemKind.Module
      });
    })
  }
  return items;
});

/*
.dP"Y8 88  dP""b8 88b 88    db    888888 88   88 88""Yb 888888 
`Ybo." 88 dP   `" 88Yb88   dPYb     88   88   88 88__dP 88__   
o.`Y8b 88 Yb  "88 88 Y88  dP__Yb    88   Y8   8P 88"Yb  88""   
8bodP' 88  YboodP 88  Y8 dP""""Yb   88   `YbodP' 88  Yb 888888 
*/
connection.onSignatureHelp((positionParams): SignatureHelp => {
  let document = documents.get(positionParams.textDocument.uri);
  let activeSignature = null, activeParameter = null, signatures: SignatureInformation[] = [];
  if (document) {
    let iterator = new BackwardIterator(document, positionParams.position.character - 1, positionParams.position.line);

    let paramCount = iterator.readArguments();
    if (paramCount < 0) return null;

    let ident = iterator.readIdent();
    if (!ident || ident.match(/^\".*?\"$/)) return null;

    let fn = functionCache.find(f => f.name.toLocaleLowerCase() === ident.toLocaleLowerCase());
    if (!fn) return null;

    let overloads = fn.overloads.filter(o => o.args.length >= paramCount);
    if (!overloads || !overloads.length) return null;

    overloads.forEach(overload => {
      signatures.push({
        label: `${fn.name}( ${overload.args.join(' , ')} )`,
        documentation: overload.description,
        parameters: overload.args.map<ParameterInformation>(v => { return {label: v}})
      });
    });

    activeSignature = 0;
    activeParameter = Math.min(paramCount, overloads[0].args.length - 1);
  }
  return { signatures, activeSignature, activeParameter };
});

function fixQuotedIdent(str: string): string {
  return str.replace(/^\"/, '').replace(/\"$/, '').replace(/\"\"/, '"');
}

// setup the language service
connection.listen();