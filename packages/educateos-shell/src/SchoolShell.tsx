import {
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type AnchorHTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import {
  AddressBookIcon,
  ArrowSquareOutIcon,
  ArrowsClockwiseIcon,
  BooksIcon,
  CalendarBlankIcon,
  CaretUpDownIcon,
  ChalkboardTeacherIcon,
  ChartBarIcon,
  CoinsIcon,
  DeviceMobileIcon,
  DevicesIcon,
  ExamIcon,
  HouseIcon,
  ListIcon,
  LockSimpleIcon,
  PaletteIcon,
  ShieldCheckIcon,
  SignOutIcon,
  SparkleIcon,
  SquaresFourIcon,
  SunHorizonIcon,
  TableIcon,
  TrayIcon,
  UserListIcon,
  UsersThreeIcon,
  XIcon,
  type Icon,
} from "@phosphor-icons/react";
import { ThemeModeButton } from "@gadgets/ui/theme";
import type { SchoolManifest } from "./manifest.ts";
import { ROLE_LABELS, activeItemId, navigationFor, type NavGroup, type NavIcon, type ShellFeatures, type ShellLocation, type ShellRole } from "./navigation.ts";
import { useBrandAccent } from "./theme.ts";

const ICONS: Record<NavIcon, Icon> = {
  home: HouseIcon,
  classes: BooksIcon,
  calendar: CalendarBlankIcon,
  inbox: TrayIcon,
  grades: ExamIcon,
  ai: SparkleIcon,
  "my-space": LockSimpleIcon,
  today: SunHorizonIcon,
  gradebook: TableIcon,
  studio: PaletteIcon,
  family: UsersThreeIcon,
  dashboard: SquaresFourIcon,
  roster: UserListIcon,
  guardians: AddressBookIcon,
  policies: ShieldCheckIcon,
  budgets: CoinsIcon,
  usage: ChartBarIcon,
  rollover: ArrowsClockwiseIcon,
  external: ArrowSquareOutIcon,
};

/** What a shell link is drawn with. Plain anchors by default; an SPA may route its own paths. */
export type ShellLinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & { href: string };

const PlainLink = (props: ShellLinkProps) => <a {...props} />;

const DESKTOP_QUERY = "(min-width: 48rem)";

const subscribeToViewport = (listener: () => void) => {
  if (typeof window.matchMedia !== "function") return () => {};
  const query = window.matchMedia(DESKTOP_QUERY);
  query.addEventListener("change", listener);
  return () => query.removeEventListener("change", listener);
};

/** Whether the viewport is narrower than a tablet, which folds the sidebar into a drawer. */
const useIsNarrow = (): boolean =>
  useSyncExternalStore(subscribeToViewport, () => typeof window.matchMedia === "function" && !window.matchMedia(DESKTOP_QUERY).matches, () => false);

const subscribeToLocation = (listener: () => void) => {
  window.addEventListener("popstate", listener);
  window.addEventListener("hashchange", listener);
  return () => {
    window.removeEventListener("popstate", listener);
    window.removeEventListener("hashchange", listener);
  };
};
const readLocation = () => `${window.location.pathname}\u0000${window.location.hash}`;

/** The browser's location, followed across back, forward and hash changes. */
const useWindowLocation = (): ShellLocation => {
  const [pathname = "/", hash = ""] = useSyncExternalStore(subscribeToLocation, readLocation, () => "/\u0000").split("\u0000");
  return { pathname, hash };
};

/** The signed-in person, as the user menu names them. */
export interface ShellUser {
  name: string;
}

/** The user menu's own destinations. */
export interface ShellAccount {
  /** The "Connect phone" page. Offered only where the school's manifest has `features.mobile`. */
  connectPhoneHref?: string;
  /** The "Your devices" page. Offered only where the school's manifest has `features.mobile`. */
  devicesHref?: string;
  /**
   * The sign-out control, which differs by how the SPA signs in. Defaults to Access's logout;
   * `null` offers none, for a host that signs people in and out itself.
   */
  signOut?: ReactNode;
}

export interface SchoolShellProps {
  /** The district's manifest (`useSchoolManifest().manifest`): its name, logo and accent. */
  school: SchoolManifest;
  /** Who is signed in. Undefined while that is still loading: the navigation waits for it. */
  role: ShellRole | undefined;
  user: ShellUser | undefined;
  /** The district features and policy the navigation follows. Defaults to the manifest's. */
  features?: ShellFeatures;
  /** Replaces the role's navigation outright, for a surface with places of its own. */
  navigation?: NavGroup[];
  /** Where the SPA is. Defaults to the browser's location; a router using pushState should pass its own. */
  location?: ShellLocation;
  /** Counts to show beside entries, by entry id: `{ inbox: 3 }`. */
  badges?: Partial<Record<string, number>>;
  account?: ShellAccount;
  /** Draws every link. Defaults to a plain anchor, which is right for cross-SPA links. */
  renderLink?: (props: ShellLinkProps) => ReactElement;
  /** Receives what the theme control says when it changes the theme, for the SPA's live region. */
  onAnnounce: (message: string) => void;
  /** A slot above the content: search (⌘K) or page actions. */
  headerActions?: ReactNode;
  /**
   * How the content sits in the frame. `page` (the default) is a centred, padded column in a page
   * that scrolls. `fill` gives the content all the space beside the sidebar, at the height of its
   * container, for an SPA with panes and scrolling of its own (the AI workspace): the frame then
   * leaves the `<main>` landmark to the content.
   */
  layout?: "page" | "fill";
  children: ReactNode;
}

const Brand = ({ school, href }: { school: SchoolManifest; href: string }) => {
  const [logoFailed, setLogoFailed] = useState(false);
  const logo = school.brand.logo;
  return (
    <a href={href} className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1 outline-none focus-visible:ring-2 focus-visible:ring-kumo-focus">
      {logo !== undefined && !logoFailed ? (
        <img src={logo} alt="" className="size-7 shrink-0 rounded object-contain" onError={() => setLogoFailed(true)} />
      ) : (
        <ChalkboardTeacherIcon aria-hidden size={24} className="shrink-0 text-kumo-brand" />
      )}
      <span className="truncate font-semibold text-kumo-strong">{school.name}</span>
    </a>
  );
};

const ITEM_CLASS =
  "flex items-center gap-3 rounded-md px-2 py-2 text-kumo-default no-underline outline-none hover:bg-kumo-tint focus-visible:ring-2 focus-visible:ring-kumo-focus aria-[current=page]:bg-kumo-tint aria-[current=page]:font-semibold aria-[current=page]:text-kumo-brand";

const Navigation = ({
  groups,
  location,
  badges,
  renderLink: LinkComponent,
  onNavigate,
}: {
  groups: NavGroup[];
  location: ShellLocation;
  badges: Partial<Record<string, number>>;
  renderLink: (props: ShellLinkProps) => ReactElement;
  onNavigate?: () => void;
}) => {
  const baseId = useId();
  const active = activeItemId(groups, location);
  // No landmark until there is somewhere to go: an empty navigation is only noise to a screen reader.
  if (groups.every((group) => group.items.length === 0)) return null;
  return (
    <nav aria-label="Main" className="flex flex-col gap-4">
      {groups.map((group) => {
        if (group.items.length === 0) return null;
        const labelId = `${baseId}-${group.id}`;
        return (
          <div key={group.id} className="flex flex-col gap-1">
            {group.label === undefined ? null : (
              <p id={labelId} className="px-2 text-xs font-medium uppercase tracking-wide text-kumo-subtle">
                {group.label}
              </p>
            )}
            <ul className="flex flex-col gap-0.5" {...(group.label === undefined ? {} : { "aria-labelledby": labelId })}>
              {group.items.map((item) => {
                const Icon = ICONS[item.icon];
                const count = badges[item.id] ?? 0;
                return (
                  <li key={item.id}>
                    <LinkComponent
                      href={item.href}
                      className={ITEM_CLASS}
                      {...(item.id === active ? { "aria-current": "page" as const } : {})}
                      {...(item.external === true ? { target: "_blank", rel: "noopener noreferrer" } : {})}
                      {...(onNavigate === undefined ? {} : { onClick: onNavigate })}
                    >
                      <Icon aria-hidden size={20} className="shrink-0" />
                      <span className="flex-1 truncate">{item.label}</span>
                      {count > 0 ? (
                        <>
                          <span aria-hidden className="rounded-full bg-kumo-brand px-1.5 text-xs font-semibold text-white">
                            {count}
                          </span>
                          <span className="sr-only">{`, ${count} new`}</span>
                        </>
                      ) : null}
                      {item.external === true ? <span className="sr-only"> (opens in a new tab)</span> : null}
                    </LinkComponent>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </nav>
  );
};

const AccountMenu = ({
  user,
  role,
  school,
  account,
  renderLink: LinkComponent,
  onAnnounce,
}: {
  user: ShellUser | undefined;
  role: ShellRole | undefined;
  school: SchoolManifest;
  account: ShellAccount;
  renderLink: (props: ShellLinkProps) => ReactElement;
  onAnnounce: (message: string) => void;
}) => {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const close = () => {
    setOpen(false);
    buttonRef.current?.focus();
  };
  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key === "Escape" && open) {
      event.stopPropagation();
      close();
    }
  };
  const mobile = school.features.mobile;
  const signOut = account.signOut !== undefined ? account.signOut : (
    <a href="/cdn-cgi/access/logout" className={ITEM_CLASS}>
      <SignOutIcon aria-hidden size={20} />
      Sign out
    </a>
  );
  return (
    <div className="flex flex-col gap-1 border-t border-kumo-hairline pt-3" onKeyDown={onKeyDown}>
      {open ? (
        <ul id={panelId} aria-label="Account" className="flex flex-col gap-0.5">
          {mobile ? (
            <>
              <li>
                <LinkComponent href={account.connectPhoneHref ?? "/devices/connect"} className={ITEM_CLASS}>
                  <DeviceMobileIcon aria-hidden size={20} />
                  Connect phone
                </LinkComponent>
              </li>
              <li>
                <LinkComponent href={account.devicesHref ?? "/devices"} className={ITEM_CLASS}>
                  <DevicesIcon aria-hidden size={20} />
                  Your devices
                </LinkComponent>
              </li>
            </>
          ) : null}
          {signOut === null ? null : <li>{signOut}</li>}
        </ul>
      ) : null}
      <div className="flex items-center gap-1">
        <button
          ref={buttonRef}
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((was) => !was)}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left outline-none hover:bg-kumo-tint focus-visible:ring-2 focus-visible:ring-kumo-focus"
        >
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-sm font-medium text-kumo-default">{user?.name ?? "Signed in"}</span>
            {role === undefined ? null : <span className="truncate text-xs text-kumo-subtle">{ROLE_LABELS[role]}</span>}
          </span>
          <CaretUpDownIcon aria-hidden size={16} className="shrink-0 text-kumo-subtle" />
          <span className="sr-only">, account menu</span>
        </button>
        <ThemeModeButton onAnnounce={onAnnounce} />
      </div>
    </div>
  );
};

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The frame every EducateOS screen on a district origin sits in: the school's name and logo, the
 * role's navigation, the user menu with the theme control, and the main content. On a wide screen
 * the frame is a sidebar; below 48rem it folds into a top bar whose menu button opens the same
 * sidebar as a modal drawer, which traps focus, closes on Escape and returns focus to the button.
 * `data-layout` names the arrangement in force.
 */
export const SchoolShell = ({
  school,
  role,
  user,
  features,
  navigation,
  location,
  badges = {},
  account = {},
  renderLink = PlainLink,
  onAnnounce,
  headerActions,
  layout = "page",
  children,
}: SchoolShellProps) => {
  const fill = layout === "fill";
  useBrandAccent(school.brand.accent);
  const narrow = useIsNarrow();
  const windowLocation = useWindowLocation();
  const here = location ?? windowLocation;
  const groups = navigation ?? (role === undefined ? [] : navigationFor(role, features ?? { ai: school.features.ai }));
  // The school's name leads to the role's first place: Home for a student, Today for a teacher.
  const homeHref = groups[0]?.items[0]?.href ?? "/";

  const [drawerOpen, setDrawerOpen] = useState(false);
  const drawerRef = useRef<HTMLDivElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const drawerId = useId();

  // The drawer belongs to the narrow layout, and to the page it was opened on.
  const placeKey = `${here.pathname}${here.hash}`;
  useEffect(() => {
    setDrawerOpen(false);
  }, [placeKey, narrow]);

  useEffect(() => {
    if (!drawerOpen) return;
    const drawer = drawerRef.current;
    drawer?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setDrawerOpen(false);
        return;
      }
      if (event.key !== "Tab" || drawer === null) return;
      const focusable = [...drawer.querySelectorAll<HTMLElement>(FOCUSABLE)];
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (first === undefined || last === undefined) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    const button = menuButtonRef.current;
    return () => {
      document.removeEventListener("keydown", onKey);
      button?.focus();
    };
  }, [drawerOpen]);

  const sidebar = (onNavigate?: () => void) => (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-3">
      <Navigation groups={groups} location={here} badges={badges} renderLink={renderLink} {...(onNavigate === undefined ? {} : { onNavigate })} />
      <div className="mt-auto">
        <AccountMenu user={user} role={role} school={school} account={account} renderLink={renderLink} onAnnounce={onAnnounce} />
      </div>
    </div>
  );

  return (
    <div
      data-layout={narrow ? "narrow" : "wide"}
      data-content={layout}
      className={`flex bg-kumo-base text-kumo-default ${fill ? "h-full min-h-0 overflow-hidden" : "min-h-dvh"}`}
    >
      {/* Focuses the content directly: following `#main` would replace a hash-routed SPA's screen. */}
      <a
        href="#main"
        onClick={(event) => {
          event.preventDefault();
          document.getElementById("main")?.focus();
        }}
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded focus:bg-kumo-elevated focus:p-2">
        Skip to content
      </a>
      {narrow ? null : (
        <header className={`flex w-64 shrink-0 flex-col border-r border-kumo-hairline bg-kumo-elevated ${fill ? "h-full" : "sticky top-0 h-dvh"}`}>
          <div className="px-3 pt-3">
            <Brand school={school} href={homeHref} />
          </div>
          {sidebar()}
        </header>
      )}
      {narrow && drawerOpen ? (
        <>
          <div className="fixed inset-0 z-40 bg-black/30" aria-hidden onClick={() => setDrawerOpen(false)} />
          <div
            ref={drawerRef}
            id={drawerId}
            role="dialog"
            aria-modal="true"
            aria-label="Menu"
            className="fixed inset-y-0 left-0 z-50 flex w-72 max-w-[85vw] flex-col bg-kumo-elevated shadow-lg"
          >
            <div className="flex items-center justify-between gap-2 px-3 pt-3">
              <Brand school={school} href={homeHref} />
              <button
                type="button"
                aria-label="Close menu"
                onClick={() => setDrawerOpen(false)}
                className="rounded-md p-2 outline-none hover:bg-kumo-tint focus-visible:ring-2 focus-visible:ring-kumo-focus"
              >
                <XIcon aria-hidden size={20} />
              </button>
            </div>
            {sidebar(() => setDrawerOpen(false))}
          </div>
        </>
      ) : null}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col" {...(narrow && drawerOpen ? { inert: true, "aria-hidden": true } : {})}>
        {narrow ? (
          <header className="sticky top-0 z-30 flex items-center gap-2 border-b border-kumo-hairline bg-kumo-elevated px-2 py-2">
            <button
              ref={menuButtonRef}
              type="button"
              aria-label="Open menu"
              aria-expanded={drawerOpen}
              aria-controls={drawerId}
              onClick={() => setDrawerOpen(true)}
              className="rounded-md p-2 outline-none hover:bg-kumo-tint focus-visible:ring-2 focus-visible:ring-kumo-focus"
            >
              <ListIcon aria-hidden size={22} />
            </button>
            <Brand school={school} href={homeHref} />
            {headerActions === undefined ? null : <div className="ml-auto flex items-center gap-2">{headerActions}</div>}
          </header>
        ) : headerActions === undefined ? null : (
          <div className="flex items-center justify-end gap-2 border-b border-kumo-hairline px-6 py-2">{headerActions}</div>
        )}
        {fill ? (
          <div id="main" tabIndex={-1} className="flex min-h-0 w-full flex-1 flex-col outline-none">
            {children}
          </div>
        ) : (
          <main id="main" tabIndex={-1} className="mx-auto w-full max-w-5xl flex-1 px-4 py-6 outline-none md:px-8">
            {children}
          </main>
        )}
      </div>
    </div>
  );
};
