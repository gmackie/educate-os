import { Link, Text } from "@cloudflare/kumo";
import { BookOpen, ChalkboardTeacher } from "@phosphor-icons/react";

/** What someone the school has added, but not as a district administrator, sees instead of the console. */
export const NotAnAdministrator = () => (
  <section aria-labelledby="not-admin-heading" className="flex max-w-xl flex-col gap-4">
    <Text as="h2" variant="heading" size="lg">
      <span id="not-admin-heading">You're not an administrator of this school</span>
    </Text>
    <Text>The admin console is for the school's administrators. If you need it, ask one of them to make you an administrator.</Text>
    <nav aria-label="Other SchoolOS apps">
      <ul className="flex flex-col gap-1">
        <li>
          <Link href="/" className="flex items-center gap-2 py-2">
            <BookOpen aria-hidden size={20} />
            Learning Home
          </Link>
        </li>
        <li>
          <Link href="/teach/" className="flex items-center gap-2 py-2">
            <ChalkboardTeacher aria-hidden size={20} />
            Teacher Studio
          </Link>
        </li>
      </ul>
    </nav>
  </section>
);
