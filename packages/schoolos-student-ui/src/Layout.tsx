import { useSyncExternalStore, type ReactNode } from "react";
import { Link, Text } from "@cloudflare/kumo";
import { BookOpenIcon, ExamIcon, HouseIcon, LockSimpleIcon } from "@phosphor-icons/react";

const DESKTOP_QUERY = "(min-width: 48rem)";

const subscribeToViewport = (listener: () => void) => {
  if (typeof window.matchMedia !== "function") return () => {};
  const query = window.matchMedia(DESKTOP_QUERY);
  query.addEventListener("change", listener);
  return () => query.removeEventListener("change", listener);
};

/** Whether the viewport is phone-sized, which moves the main navigation to the bottom of the screen. */
const useIsPhone = (): boolean =>
  useSyncExternalStore(subscribeToViewport, () => typeof window.matchMedia === "function" && !window.matchMedia(DESKTOP_QUERY).matches);

const MainNav = ({ label }: { label: string }) => (
  <nav aria-label={label}>
    <ul className="flex items-center gap-6">
      <li>
        <Link href="/" variant="plain" className="flex items-center gap-2 py-2">
          <HouseIcon aria-hidden size={20} />
          Home
        </Link>
      </li>
      <li>
        <Link href="/my-space" variant="plain" className="flex items-center gap-2 py-2">
          <LockSimpleIcon aria-hidden size={20} />
          My space
        </Link>
      </li>
      <li>
        <Link href="/grades" variant="plain" className="flex items-center gap-2 py-2">
          <ExamIcon aria-hidden size={20} />
          Grades
        </Link>
      </li>
    </ul>
  </nav>
);

/**
 * The frame every screen sits in: a skip link, the header, the main landmark, and the navigation,
 * which sits in the header on a wide screen and along the bottom on a phone, within thumb reach.
 * `data-layout` names the arrangement in force.
 */
export const Layout = ({ studentName, children }: { studentName: string | undefined; children: ReactNode }) => {
  const isPhone = useIsPhone();
  return (
    <div data-layout={isPhone ? "phone" : "desktop"} className="min-h-dvh bg-kumo-base text-kumo-default">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded focus:bg-kumo-elevated focus:p-2">
        Skip to content
      </a>
      <header className="border-b border-kumo-hairline">
        <div className="mx-auto flex max-w-4xl items-center justify-between gap-4 px-4 py-3">
          <Text variant="heading" as="p">
            <span className="flex items-center gap-2">
              <BookOpenIcon aria-hidden size={24} />
              Learning Home
            </span>
          </Text>
          {isPhone ? null : <MainNav label="Main" />}
          {studentName === undefined ? null : <Text variant="secondary">{studentName}</Text>}
        </div>
      </header>
      <main id="main" tabIndex={-1} className={`mx-auto max-w-4xl px-4 py-6 outline-none ${isPhone ? "pb-28" : ""}`}>
        {children}
      </main>
      {isPhone ? (
        <div className="fixed inset-x-0 bottom-0 border-t border-kumo-hairline bg-kumo-elevated px-6 pb-[env(safe-area-inset-bottom)]">
          <MainNav label="Main" />
        </div>
      ) : null}
    </div>
  );
};
