import { describe, expect, it } from "vitest";
import { isPublicAddress } from "../src/index.ts";

describe("isPublicAddress", () => {
  it("refuses every address a request could use to reach a private network or the host itself", () => {
    for (const address of [
      "10.0.0.1", "127.0.0.1", "169.254.169.254", "100.64.0.1", "172.16.0.1", "172.31.255.255", "192.168.1.1", "0.0.0.0",
      "255.255.255.255", "224.0.0.1", "198.18.0.1", "192.0.2.1",
      "::1", "::", "fe80::1", "fc00::1", "fd12:3456::1", "ff02::1",
      // Encodings of private IPv4 inside IPv6.
      "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:a9fe:a9fe", "2002:7f00:1::1", "64:ff9b::7f00:1",
      "2001::1", "2001:db8::1",
    ]) expect(isPublicAddress(address), address).toBe(false);
  });

  it("accepts public addresses", () => {
    for (const address of ["93.184.216.34", "8.8.8.8", "172.32.0.1", "2606:4700:4700::1111", "2001:4860:4860::8888", "::ffff:8.8.8.8", "2600:1:2:3:4:5:1.2.3.4"]) {
      expect(isPublicAddress(address), address).toBe(true);
    }
  });

  it("treats anything that does not parse as not public", () => {
    for (const address of ["", "garbage", "1.2.3", "1.2.3.256", "2606::1::2", "12345::1", "localhost"]) expect(isPublicAddress(address), address).toBe(false);
  });
});
