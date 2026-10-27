// y/N confirmation prompt.
import readline from 'node:readline/promises';

/** One line of input, with a default used when the answer is empty. */
export async function askLine(question, fallback = '', io = { out: process.stdout, stdin: process.stdin }) {
  const rl = readline.createInterface({ input: io.stdin, output: io.out });
  try {
    const answer = (await rl.question(question)).trim();
    return answer || fallback;
  } finally {
    rl.close();
  }
}

export async function askYesNo(question, io = { out: process.stdout, stdin: process.stdin }) {
  const rl = readline.createInterface({ input: io.stdin, output: io.out });
  try {
    const answer = await rl.question(question);
    return /^\s*y(es)?\s*$/i.test(answer);
  } finally {
    rl.close();
  }
}
