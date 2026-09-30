import { BadRequestException, PreconditionFailedException } from "@nestjs/common";
import { etagFor, parseIfMatch, preconditionFailed } from "./etag";
import { VersionConflict } from "./intents.repository";

describe("intent ETags (issue #405)", () => {
  it("renders the version as a strong quoted tag", () => {
    expect(etagFor({ version: 3 })).toBe('"3"');
  });

  it.each([
    ['"3"', 3],
    ['W/"3"', 3],
    ["3", 3],
    [' "12" ', 12],
  ])("parses If-Match %s", (header, expected) => {
    expect(parseIfMatch(header)).toBe(expected);
  });

  it.each([undefined, "", "*"])("treats %p as unconditional", (header) => {
    expect(parseIfMatch(header)).toBeUndefined();
  });

  it.each(['"1", "2"', '"abc"', "W/3", '"-1"'])("rejects malformed If-Match %s", (header) => {
    expect(() => parseIfMatch(header)).toThrow(BadRequestException);
  });

  it("builds a 412 that tells the client the current ETag", () => {
    const err = preconditionFailed(new VersionConflict("i-1", 2, 5));
    expect(err).toBeInstanceOf(PreconditionFailedException);
    expect(err.getResponse()).toMatchObject({ expectedVersion: 2, currentVersion: 5, currentETag: '"5"' });
  });
});
