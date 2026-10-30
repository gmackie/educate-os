import { useId, type AnchorHTMLAttributes, type ReactElement } from "react";
import {
  AddressBookIcon, ArrowSquareOutIcon, ArrowsClockwiseIcon, BooksIcon, CalendarBlankIcon,
  ChartBarIcon, CoinsIcon, ExamIcon, HouseIcon, LockSimpleIcon, PaletteIcon,
  ShieldCheckIcon, SparkleIcon, SquaresFourIcon, SunHorizonIcon, TableIcon,
  TrayIcon, UserListIcon, UsersThreeIcon, type Icon,
} from "@phosphor-icons/react";
import { activeItemId, type NavGroup, type NavIcon, type ShellLocation } from "./navigation.ts";

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

const ITEM_CLASS =
  "flex items-center gap-3 rounded-md px-2 py-2 text-kumo-default no-underline outline-none hover:bg-kumo-tint focus-visible:ring-2 focus-visible:ring-kumo-focus aria-[current=page]:bg-kumo-tint aria-[current=page]:font-semibold aria-[current=page]:text-kumo-brand";

/** Role-aware school navigation, also embedded in the AI workspace sidebar. */
export const SchoolNavigation = ({
  groups,
  location,
  badges = {},
  renderLink: LinkComponent = PlainLink,
  onNavigate,
  collapsed = false,
}: {
  groups: NavGroup[];
  location: ShellLocation;
  badges?: Partial<Record<string, number>>;
  renderLink?: (props: ShellLinkProps) => ReactElement;
  onNavigate?: () => void;
  /** Keeps destinations named for assistive technology while the AI sidebar shows icons. */
  collapsed?: boolean;
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
              <p id={labelId} className={collapsed ? "sr-only" : "px-2 text-xs font-medium uppercase tracking-wide text-kumo-subtle"}>
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
                      className={`${ITEM_CLASS} ${collapsed ? "justify-center" : ""}`}
                      title={collapsed ? item.label : undefined}
                      {...(item.id === active ? { "aria-current": "page" as const } : {})}
                      {...(item.external === true ? { target: "_blank", rel: "noopener noreferrer" } : {})}
                      {...(onNavigate === undefined ? {} : { onClick: onNavigate })}
                    >
                      <Icon aria-hidden size={20} className="shrink-0" />
                      <span className={collapsed ? "sr-only" : "flex-1 truncate"}>{item.label}</span>
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
