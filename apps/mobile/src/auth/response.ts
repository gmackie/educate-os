type BrowserResult = { type: string; url?: string };

/** Universal links can arrive independently just before the system browser dismisses. */
export async function authResponseUrl(result: BrowserResult, incomingLink: Promise<string>, graceMs = 500): Promise<string> {
  if (result.type === 'success' && result.url) return result.url;
  const cancelled = result.type === 'cancel' || result.type === 'dismiss';
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      incomingLink,
      new Promise<string>((_, reject) => {
        timer = setTimeout(() => reject(new Error(cancelled
          ? 'Sign-in closed before returning to EducateOS. Please try again.'
          : "The school's app-link sign-in timed out.")), cancelled ? graceMs : 120_000);
      }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}
