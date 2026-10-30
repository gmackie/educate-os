const kind = location.pathname === '/pair-phone' ? 'pair' : 'enroll';
const link = document.getElementById('open-app');
if (location.hash && !location.search) {
  link.href = 'educateos://' + kind + '?' + location.hash.slice(1);
} else {
  document.getElementById('status').textContent = 'This code is incomplete. Ask for a new school or computer pairing QR code.';
  link.hidden = true;
}
