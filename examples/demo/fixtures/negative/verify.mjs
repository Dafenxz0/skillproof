import { readFile } from "node:fs/promises";

const answer = (await readFile("answer.txt", "utf8")).trim();
if (answer !== "plain") {
  console.error(`Expected plain, received ${answer}`);
  process.exitCode = 1;
}
