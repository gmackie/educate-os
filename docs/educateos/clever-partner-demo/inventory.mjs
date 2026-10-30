// Static API inventory, deliberately separate from provider acceptance evidence.
import { readFile, readdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire(new URL("../../../packages/bundled-blueprints/package.json", import.meta.url));
const ts = require("typescript6");
const root = new URL("../../../", import.meta.url);
const directory = new URL("packages/gatekeeper-google/src/", root);
const source = await readFile(new URL("resources.ts", directory), "utf8");
const file = ts.createSourceFile("resources.ts", source, ts.ScriptTarget.Latest, true);
const constants = new Map();
function value(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isIdentifier(node)) {
    if (!constants.has(node.text)) throw Error(`Unknown constant ${node.text}`);
    return constants.get(node.text);
  }
  if (ts.isPropertyAccessExpression(node)) {
    const object = value(node.expression);
    if (object === null || typeof object !== "object" || !Object.hasOwn(object, node.name.text)) {
      throw Error(`Unknown static property ${node.getText(file).slice(0,60)}`);
    }
    return object[node.name.text];
  }
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) return value(node.left) + value(node.right);
  if (ts.isObjectLiteralExpression(node)) return Object.fromEntries(node.properties.map((property) => [property.name.getText(file), value(property.initializer)]));
  if (ts.isArrayLiteralExpression(node)) return node.elements.flatMap((element) => ts.isSpreadElement(element) ? value(element.expression) : [value(element)]);
  if (ts.isTemplateExpression(node)) return node.head.text + node.templateSpans.map((span) => value(span.expression) + span.literal.text).join("");
  throw Error(`Unsupported static expression ${node.getText(file).slice(0,60)}`);
}
for (const statement of file.statements) {
  if (!ts.isVariableStatement(statement)) continue;
  for (const declaration of statement.declarationList.declarations) {
    const name = declaration.name.getText(file);
    if (name.endsWith("_RESOURCE") || name.endsWith("_HOST") || name === "CHAT_SCOPES" || name === "RESOURCE_SCOPES") {
      constants.set(name, value(declaration.initializer));
    }
  }
}
const interfaces = [];
for (const name of (await readdir(directory)).filter((name) => name.endsWith("types.d.ts")).toSorted()) {
  const content = await readFile(new URL(name, directory), "utf8");
  const parsed = ts.createSourceFile(name, content, ts.ScriptTarget.Latest, true);
  for (const node of parsed.statements) {
    if (!ts.isInterfaceDeclaration(node)) continue;
    interfaces.push({name:node.name.text, source:`packages/gatekeeper-google/src/${name}`,
      extends:(node.heritageClauses || []).flatMap((clause) => clause.types.map((type) => type.getText(parsed))),
      methods:node.members.filter(ts.isMethodSignature).map((method) => method.getText(parsed))});
  }
}
const evidence = JSON.parse(await readFile(new URL("./evidence.json", import.meta.url), "utf8"));
const output = {
  productionEvidenceRevision: evidence.production.commit,
  description:"Static declarations from the checked-out source; inherited methods are referenced through extends. productionEvidenceRevision identifies separate historical deployment evidence, not the source revision or live acceptance of this inventory.",
  resources: constants.get("RESOURCE_SCOPES").map(({resource,scopes}) => ({...resource,oauthScopes:scopes})),
  interfaces,
};
output.counts = {resources:output.resources.length,interfaces:interfaces.length,declaredMethods:interfaces.reduce((count,item) => count + item.methods.length,0)};
const json = JSON.stringify(output,null,2) + "\n";
const target = new URL("./google-api-inventory.json", import.meta.url);
if (process.argv.includes("--check")) {
  if (await readFile(target,"utf8") !== json) throw Error("Static Google API inventory has drifted; regenerate it.");
} else await writeFile(target,json);
console.log(`${JSON.stringify(output.counts)}; source ${fileURLToPath(directory)}; no provider calls`);
