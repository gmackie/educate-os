import { useNavigate } from '@tanstack/react-router'
import { DropdownMenu } from '@cloudflare/kumo'
import { ROLE_LABELS } from '@educateos/shell'
import { useAuthenticatedApi } from '../AuthContext'
import { useAvatar } from '../useAvatar'
import { MENU_CONTENT, MENU_ITEM, MENU_ITEM_DANGER, MENU_POSITIONER_STYLE } from './menuStyles'
import { useDistrictSidebar } from '../features/district-frame/districtFrame'

export default function UserMenu() {
  const { authenticatedApi, logout, currentUser, isAdmin } = useAuthenticatedApi()
  const navigate = useNavigate()
  const district = useDistrictSidebar()
  const name = district?.principal?.name || currentUser?.name

  const avatarUrl = useAvatar(authenticatedApi, currentUser?.id)

  const initials = name
    ? name.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase()
    : 'U'

  return (
    <DropdownMenu>
      <DropdownMenu.Trigger
        render={
          <button
            className="flex h-11 w-11 cursor-pointer items-center justify-center overflow-hidden rounded-full bg-kumo-tint transition-colors hover:bg-kumo-fill md:h-7 md:w-7"
            title="Open profile menu"
            aria-label="Open profile menu"
          >
            {avatarUrl ? (
              <img src={avatarUrl} alt="" className="w-full h-full object-cover" />
            ) : (
              <span className="text-xs font-medium text-kumo-strong">{initials}</span>
            )}
          </button>
        }
      />
      <DropdownMenu.Content className={MENU_CONTENT} style={MENU_POSITIONER_STYLE}>
        <DropdownMenu.Group>
          {district && (
            <DropdownMenu.Label>
              {name ?? 'Signed in'}
              {district.principal && <span className="block text-xs text-kumo-subtle">{ROLE_LABELS[district.principal.role]}</span>}
            </DropdownMenu.Label>
          )}
          <DropdownMenu.Item
            onClick={() => navigate({ to: '/profile' })}
            className={MENU_ITEM}
          >
            Profile
          </DropdownMenu.Item>
          <DropdownMenu.Item
            onClick={() => navigate({ to: '/providers' })}
            className={MENU_ITEM}
          >
            Providers
          </DropdownMenu.Item>
          {isAdmin && (
            <DropdownMenu.Item
              onClick={() => navigate({ to: '/admin' })}
              className={MENU_ITEM}
            >
              Admin
            </DropdownMenu.Item>
          )}
          {district?.school.features.mobile && (
            <>
              <DropdownMenu.Separator />
              <DropdownMenu.LinkItem href="/devices/connect" className={MENU_ITEM}>Connect phone</DropdownMenu.LinkItem>
              <DropdownMenu.LinkItem href="/devices" className={MENU_ITEM}>Your devices</DropdownMenu.LinkItem>
            </>
          )}
          <DropdownMenu.Separator />
          <DropdownMenu.Item
            variant="danger"
            onClick={logout}
            className={MENU_ITEM_DANGER}
          >
            Sign out
          </DropdownMenu.Item>
        </DropdownMenu.Group>
      </DropdownMenu.Content>
    </DropdownMenu>
  )
}
