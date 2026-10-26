// Wrangler bundles the shared partials as Text modules (its default rule for `.html`).
declare module "*.html" {
  const text: string;
  export default text;
}
