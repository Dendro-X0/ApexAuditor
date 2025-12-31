const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const SPINNER_INTERVAL_MS: number = 80;
const ANSI_BLUE: string = "\u001B[34m";
const ANSI_RESET: string = "\u001B[0m";

let spinnerInterval: NodeJS.Timeout | undefined;
let spinnerIndex: number = 0;
let spinnerMessage: string = "";

export function startSpinner(message: string): void {
  if (!process.stdout.isTTY) {
    return;
  }
  stopSpinner();
  spinnerMessage = message;
  spinnerIndex = 0;
  process.stdout.write("\u001B[?25l"); // hide cursor
  spinnerInterval = setInterval(() => {
    process.stdout.write(`\r${ANSI_BLUE}${SPINNER_FRAMES[spinnerIndex]} ${spinnerMessage}${ANSI_RESET}`);
    spinnerIndex = (spinnerIndex + 1) % SPINNER_FRAMES.length;
  }, SPINNER_INTERVAL_MS);
}

export function updateSpinnerMessage(message: string): void {
  if (!process.stdout.isTTY || spinnerInterval === undefined) {
    return;
  }
  spinnerMessage = message;
}

export function stopSpinner(): void {
  if (spinnerInterval === undefined) {
    return;
  }
  clearInterval(spinnerInterval);
  spinnerInterval = undefined;
  if (process.stdout.isTTY) {
    process.stdout.write("\r\u001B[K"); // clear line
    process.stdout.write("\u001B[?25h"); // show cursor
  }
}
