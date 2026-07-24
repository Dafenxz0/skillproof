import { readFile } from "node:fs/promises";

const answer = (await readFile("answer.txt", "utf8")).trim();
if (answer !== "safe") {
  console.error(`Expected safe, received ${answer}`);
  process.exitCode = 1;
}
