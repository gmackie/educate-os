import { describe, expect, it, vi } from "vitest";
import { memoryHashLocation } from "./hashLocation";

describe("memoryHashLocation", () => {
  it("tells the host about the app's own moves, and the app about the host's", () => {
    const heard: string[] = [];
    const location = memoryHashLocation("#/", (hash) => heard.push(hash));
    const changed = vi.fn();
    const unsubscribe = location.subscribe(changed);

    location.assign("#/classes");
    location.replace("#/guardians");
    expect(location.read()).toBe("#/guardians");
    expect(heard).toStrictEqual(["#/classes"]);
    expect(changed).toHaveBeenCalledTimes(2);

    unsubscribe();
    location.replace("#/roster");
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it("treats a move to where it already is as no move", () => {
    const onAssign = vi.fn();
    const location = memoryHashLocation("#/classes", onAssign);
    const changed = vi.fn();
    location.subscribe(changed);
    location.assign("#/classes");
    expect(onAssign).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();
  });
});
