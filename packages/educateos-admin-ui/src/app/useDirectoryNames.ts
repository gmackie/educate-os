import { directoryNames, type DirectoryNames } from "./labels.ts";
import { useLoad } from "./useLoad.ts";

/**
 * The names of the district's schools, terms and classes. Until they load, or if they cannot be
 * read, records are named by their code, so a screen never waits on names to show its own data.
 * The route names no person, so the count-and-total screens may use it too.
 */
export const useDirectoryNames = (): DirectoryNames => {
  const names = useLoad("directory-names", (client) => client.call("admin.directoryNames"));
  return directoryNames(names.status === "ready" ? names.data : undefined);
};
