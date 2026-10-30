export const ORIGIN = "https://synthetic.launch-factory.invalid";
export const STORYBOARD_LABEL = "SYNTHETIC STORYBOARD / NOT ACTUAL PRODUCT FOOTAGE";
export const WATERMARK = "SYNTHETIC DISTRICT DEMO";
export const escapeHtml = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
export function fixtureHtml(scene) {
  const integration = /clever|classlink|classroom|oneroster|canvas|schoology|moodle/i.test(
    scene.actions + scene.title,
  );
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>Synthetic storyboard</title>
  <style>*{box-sizing:border-box}body{margin:0;background:#101d31;color:#e9f1fc;font:22px system-ui}header{padding:24px 40px;background:#213550;display:flex;justify-content:space-between}aside{background:#8e410c;color:white;padding:14px 40px;font-weight:bold}main{padding:32px 48px}h1{font-size:38px;margin:10px 0}h2{font-size:24px;color:#92d8e9}p{line-height:1.5}section{padding:24px;background:#213550;border-radius:16px;max-width:1120px}button{padding:14px 22px;font:inherit;color:white;background:#176c85;border:0;border-radius:8px;margin:14px 12px 0 0}table{width:100%;text-align:left;margin-top:20px}th,td{padding:12px;border-bottom:1px solid #47617c}footer{position:fixed;bottom:0;padding:16px 40px;background:#7c2e22;width:100%;font-weight:bold}</style>
  <header><b>EducateOS · Production storyboard</b><span>${WATERMARK}</span></header>
  <aside>${STORYBOARD_LABEL} · UNVERIFIED${integration ? " · PROVIDER SIMULATION ONLY" : ""}</aside>
  <main><small>Fictional Northfield · Grade 7 Science · ${escapeHtml(scene.id)}</small><h1>${escapeHtml(scene.title)}</h1>
  <h2>Water Quality: Claims and Evidence</h2><section><b id="stage">Synthetic lesson preparation</b>
  <p id="detail">Descriptive objective: compare measurements and support a claim with evidence. No real students or provider accounts.</p>
  <table><tr><th>Fictional sample</th><th>Before storm</th><th>After storm</th></tr><tr><td>Upstream turbidity</td><td>4 NTU</td><td>9 NTU</td></tr><tr><td>Downstream turbidity</td><td>5 NTU</td><td>24 NTU</td></tr></table>
  <button id="preview">Preview synthetic activity</button><button id="review">Review fixture</button></section>
  <p>${escapeHtml(scene.overlay).slice(0, 240)}</p></main><footer>ILLUSTRATIVE STORYBOARD — does not prove this workflow exists in the product</footer>
  <script>document.querySelector('#preview').onclick=()=>{document.querySelector('#stage').textContent='Synthetic student preview';document.querySelector('#detail').textContent='Fictional draft: downstream measurements increased after the storm. What other evidence would help?'};document.querySelector('#review').onclick=()=>{document.querySelector('#stage').textContent='Fixture review — human checkpoint';document.querySelector('#detail').textContent='Illustration only. Product claims and real workflows remain UNVERIFIED.'};</script></html>`;
}
export function overlayHtml(scene, status) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><style>html,body{margin:0;background:transparent;font:22px system-ui;color:white}header{position:absolute;top:0;left:0;right:0;background:#101d31f5;padding:18px 28px;display:flex;justify-content:space-between}footer{position:absolute;bottom:0;left:0;right:0;background:#7c2e22f5;padding:18px 28px;line-height:1.5}.badge{color:#ffe6a3;font-weight:bold}</style><header><b>${WATERMARK}</b><span>${escapeHtml(scene.id)} · ${escapeHtml(status)}</span></header><footer><b class="badge">${STORYBOARD_LABEL}</b><br>UNVERIFIED CLAIMS · INTERNAL DRAFT · ${escapeHtml(scene.title)}<br>Provider footage is simulated; no live Clever/ClassLink verification.</footer></html>`;
}
