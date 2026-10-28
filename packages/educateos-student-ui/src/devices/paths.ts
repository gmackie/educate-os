// Where the pages every role shares live (SCHO-260). Apart from router.tsx, so the pages can link to
// each other without importing the router that imports them.

/** Your devices: every role's, so teachers and administrators reach it on this SPA too. */
export const DEVICES_PATH = "/devices";

/** Connect phone: opens a pairing room and shows its QR. */
export const CONNECT_PHONE_PATH = "/devices/connect";
