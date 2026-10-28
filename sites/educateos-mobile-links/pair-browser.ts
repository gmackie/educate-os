import QRCode from 'qrcode';
import { schoolDetails, type Claim } from './pairing';

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
let generation = 0;
let active: { id: string; browserToken: string; workshop: string; expiresAt: number } | undefined;
const error = (message: string) => { el('error').textContent = message; };
const request = async (path: string, token?: string, data?: unknown) => {
  const response = await fetch(path, { method: data === undefined ? 'GET' : 'POST', credentials: 'omit', cache: 'no-store',
    headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(data ? { 'Content-Type': 'application/json' } : {}) },
    body: data === undefined ? undefined : JSON.stringify(data) });
  if (!response.ok) throw new Error(response.status === 410 ? 'This pairing code expired. Start again.' : 'Pairing could not be completed. Start again.');
  return response.json() as Promise<{ id: string; browserToken: string; phoneToken: string; expiresAt: number; claim?: Claim }>;
};
el<HTMLFormElement>('school').addEventListener('submit', async event => {
  event.preventDefault(); error('');
  const current = ++generation;
  try {
    const school = schoolDetails({ name: el<HTMLInputElement>('name').value, portal: el<HTMLInputElement>('portal').value,
      workshop: el<HTMLInputElement>('workshop').value });
    if ((event.submitter as HTMLButtonElement | null)?.value === 'school') {
      const link = 'https://mobile.educateos.io/enroll#' + new URLSearchParams(school);
      el<HTMLAnchorElement>('phone-link').href = link;
      await QRCode.toCanvas(el<HTMLCanvasElement>('qr'), link, { width: 420, errorCorrectionLevel: 'M', margin: 4 });
      el('school').hidden = true; el('pairing').hidden = false;
      el('instructions').textContent = 'Scan with your phone’s Camera app and open EducateOS. Review and save the school details, then sign in with your school account.';
      el('status').textContent = 'This reusable QR contains only public school addresses. It does not grant account access.';
      return;
    }
    const result = await request('/pairings', undefined, school);
    if (current !== generation) return;
    active = { id: result.id, browserToken: result.browserToken, workshop: school.workshop, expiresAt: result.expiresAt };
    const link = 'https://mobile.educateos.io/pair-phone#' + new URLSearchParams({ ...school, id: result.id, secret: result.phoneToken });
    el<HTMLAnchorElement>('phone-link').href = link;
    await QRCode.toCanvas(el<HTMLCanvasElement>('qr'), link, { width: 420, errorCorrectionLevel: 'M', margin: 4 });
    el('school').hidden = true; el('pairing').hidden = false;
    const poll = async () => {
      if (current !== generation || !active) return;
      try {
        const status = await request('/pairings/' + result.id, result.browserToken);
        if (current !== generation) return;
        const claim = status.claim;
        if (claim) {
          el('status').textContent = 'Your phone is ready. Compare the codes before continuing.';
          el('code').textContent = claim.code;
          el('approval').hidden = false;
          el<HTMLButtonElement>('approve').addEventListener('click', async () => {
            try {
              await request('/pairings/' + result.id + '/approve', result.browserToken, { code: claim.code });
              const target = new URL('/', school.workshop);
              target.searchParams.set('cfos_native_state', claim.state);
              target.searchParams.set('cfos_native_key', claim.publicKey);
              // Continue in this signed-in browser. Workshop independently confirms identity and consent.
              location.assign(target.href);
            } catch (e) { error(e instanceof Error ? e.message : 'Pairing failed.'); }
          }, { once: true });
          return;
        }
        setTimeout(() => { void poll(); }, 1500);
      } catch (e) { error(e instanceof Error ? e.message : 'Pairing failed.'); }
    };
    void poll();
  } catch (e) { error(e instanceof Error ? e.message : 'Pairing failed.'); }
});
el('restart').addEventListener('click', () => { generation++; active = undefined; location.reload(); });
