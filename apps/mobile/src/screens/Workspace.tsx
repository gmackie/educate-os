import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Linking, Platform, Text, View } from 'react-native';
import { WebView } from 'react-native-webview';
import * as WebBrowser from 'expo-web-browser';
import type { WebViewMessageEvent } from 'react-native-webview';
import type { Session } from '../types';
import { CALLBACK_ORIGIN } from '../district';
import { appLink, trustedUrl } from '../security';
import { workspaceOrigin } from '../schools';
import { themeScript, type ColorMode } from '../theme';
import { useTheme } from '../ui/theme-context';
import { Button, Loading, Placeholder } from '../ui/Primitives';

type BridgeMessage =
  | { kind: 'login-ready' } | { kind: 'return' }
  | { kind: 'open-auth'; id: string; url: string } | { kind: 'close-auth'; id: string };

function bridgeScript(workshopToken: string | null, mode: ColorMode, accent?: string | null): string {
  // Injected into the main frame only, at the configured school origin.
  // Never put an Access JWT into page JavaScript.
  // Pin the web theme to the native one before the page reads its stored preference.
  const themeSetup = themeScript(mode, accent);
  const credentialSetup = workshopToken ?
    'var wanted=' + JSON.stringify(workshopToken) + ';' +
    'if(localStorage.getItem("authToken")!==wanted){' +
      'localStorage.setItem("authToken",wanted);' +
      'if(document.readyState!=="loading"&&!sessionStorage.getItem("educateos.native.reload")){' +
        'sessionStorage.setItem("educateos.native.reload","1");location.reload();}}' :
    'localStorage.removeItem("authToken");';
  return '(function(){' +
    'if(window.top!==window)return;' +
    'var host=window.ReactNativeWebView;if(!host)return;' +
    'var send=function(x){host.postMessage(JSON.stringify(x));};' +
    'window.cloudflareOSNative={' +
      'version:1,isAvailable:function(){return true;},' +
      'loginReady:function(){send({kind:"login-ready"});},' +
      'returnToInstalls:function(){send({kind:"return"});},' +
      'authentication:{open:function(id,url){send({kind:"open-auth",id:id,url:url});},' +
        'close:function(id){send({kind:"close-auth",id:id});}}};' +
    themeSetup + credentialSetup +
    '})();true;';
}
function popupResult(link: string, id: string): { id: string; ticket: string } | null {
  try {
    const u = appLink(link, CALLBACK_ORIGIN, '/authpopup');
    if (!u) return null;
    const data = new URLSearchParams(u.hash.slice(1));
    if (data.getAll('id').length !== 1 || data.getAll('ticket').length !== 1) return null;
    if (data.get('id') !== id || !/^[a-f0-9]{64}$/.test(data.get('ticket') || '')) return null;
    return { id, ticket: data.get('ticket')! };
  } catch { return null; }
}

export function Workspace({ session, onReturn }: { session: Session; onReturn: () => void }) {
  const view = useRef<WebView<object>>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const activePopup = useRef<string | null>(null);
  const mounted = useRef(true);
  const { mode, palette } = useTheme();
  const origin = workspaceOrigin(session.district);
  const accent = session.district.brand?.accent;
  // The Workshop's handoff page, under its base path (`/ai/connect/handoff` on one-origin schools).
  const handoffPath = new URL('connect/handoff', session.district.workshop).pathname;
  const workshopToken = session.credential.kind === 'workshop' ? session.credential.token : null;
  const script = useMemo(() => bridgeScript(workshopToken, mode, accent), [workshopToken, mode, accent]);
  // Follow theme changes live, without reloading the workspace.
  useEffect(() => {
    view.current?.injectJavaScript('(function(){if(window.top!==window)return;' + themeScript(mode, accent) + '})();true;');
  }, [mode, accent]);
  useEffect(() => () => { mounted.current = false; }, []);
  const returnPopup = useCallback((id: string, ticket?: string) => {
    if (!mounted.current) return;
    const detail = JSON.stringify(ticket ? { id, ticket } : { id });
    view.current?.injectJavaScript(
      'window.dispatchEvent(new CustomEvent("cloudflare-os:auth-popup",{detail:' + detail + '}));true;',
    );
  }, []);
  const handleOpen = useCallback(async (id: string, url: string) => {
    if (!/^[a-f0-9]{64}$/.test(id) || activePopup.current ||
        !trustedUrl(url, origin) || new URL(url).pathname !== handoffPath) return;
    activePopup.current = id;
    const listener = Linking.addEventListener('url', (event) => {
      const match = popupResult(event.url, id);
      if (match) {
        returnPopup(id, match.ticket);
        if (Platform.OS === 'ios') WebBrowser.dismissAuthSession();
        else void WebBrowser.dismissBrowser();
      }
    });
    try {
      const response = await WebBrowser.openAuthSessionAsync(url, CALLBACK_ORIGIN + '/authpopup',
        { preferUniversalLinks: true });
      const match = response.type === 'success' ? popupResult(response.url, id) : null;
      returnPopup(id, match?.ticket);
    } finally {
      listener.remove();
      activePopup.current = null;
    }
  }, [origin, handoffPath, returnPopup]);
  const onMessage = (event: WebViewMessageEvent) => {
    if (!trustedUrl(event.nativeEvent.url, origin) || event.nativeEvent.data.length > 2048) return;
    let message: BridgeMessage;
    try { message = JSON.parse(event.nativeEvent.data) as BridgeMessage; } catch { return; }
    if (!message || typeof message !== 'object' || typeof message.kind !== 'string') return;
    if (message.kind === 'login-ready') setReady(true);
    if (message.kind === 'return') onReturn();
    if (message.kind === 'open-auth' && typeof message.id === 'string' && typeof message.url === 'string') {
      void handleOpen(message.id, message.url).catch(() => returnPopup(message.id));
    }
    if (message.kind === 'close-auth' && message.id === activePopup.current) {
      if (Platform.OS === 'ios') WebBrowser.dismissAuthSession();
      else void WebBrowser.dismissBrowser();
      activePopup.current = null;
    }
  };
  return <View style={{ flex: 1, backgroundColor: palette.background }}>
    {failed ? <View style={{ padding: 20 }}>
      <Placeholder title="Workspace unavailable" message="Check your school's address and your internet connection."/>
      <Button label="Try again" variant="outline" onPress={() => { setFailed(false); view.current?.reload(); }}/>
    </View> : null}
    <WebView<object> ref={view} key={session.district.id + ':' + session.confirmedAt}
      source={{ uri: session.district.workshop }} style={{ flex: 1, opacity: failed ? 0 : 1 }}
      javaScriptEnabled domStorageEnabled sharedCookiesEnabled
      thirdPartyCookiesEnabled={false} mixedContentMode="never"
      allowFileAccess={false} allowUniversalAccessFromFileURLs={false}
      originWhitelist={['https://*']} setSupportMultipleWindows={false}
      injectedJavaScriptBeforeContentLoaded={script}
      injectedJavaScriptBeforeContentLoadedForMainFrameOnly
      injectedJavaScriptForMainFrameOnly
      onMessage={onMessage}
      onLoadStart={() => setLoading(true)}
      onLoadEnd={() => {
        setLoading(false);
        // Android can miss document-start injection. Reinjection is idempotent.
        view.current?.injectJavaScript(script);
      }}
      onError={() => { setFailed(true); setLoading(false); }}
      onShouldStartLoadWithRequest={(request) => {
        if (request.isTopFrame === false) return true; // Gadget sandbox frames enforce their own CSP.
        if (trustedUrl(request.url, origin)) return true;
        if (request.url.startsWith('https://')) void WebBrowser.openBrowserAsync(request.url);
        return false;
      }}
    />
    {loading && <View style={{ position: 'absolute', top: 30, left: 0, right: 0 }}>
      <Loading label="Connecting to your AI workspace…"/></View>}
    {!loading && !ready && <View style={{ padding: 10, backgroundColor: palette.primarySoft }}>
      <Text style={{ color: palette.primary, fontSize: 12, textAlign: 'center' }}>
        If sign-in isn't finished, use your school's sign-in page. Some Access policies require a new browser session.
      </Text>
    </View>}
  </View>;
}
