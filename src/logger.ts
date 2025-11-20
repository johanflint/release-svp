import chalk from "chalk";
import * as figures from "figures";

const errorPrefix = chalk.red(figures.mainSymbols.cross);
const warnPrefix = chalk.yellow(figures.mainSymbols.warning);
const infoPrefix = chalk.green(figures.mainSymbols.tick);
const debugPrefix = chalk.gray(figures.mainSymbols.pointer);
const tracePrefix = chalk.dim.gray(figures.mainSymbols.pointerSmall);

interface LogFn {
    (message?: any, ...optionalParams: any[]): void;
}

export interface Logger {
    error: LogFn;
    warn: LogFn;
    info: LogFn;
    debug: LogFn;
    trace: LogFn;
}

export class DefaultLogger implements Logger {
    constructor(private readonly showDebug: boolean = true, private readonly showTrace: boolean = false) {}

    error: LogFn = (...args: any[]) => console.error(`${errorPrefix}`, ...args);
    warn: LogFn = (...args: any[]) => console.warn(`${warnPrefix}`, ...args);
    info: LogFn = (...args: any[]) => console.info(`${infoPrefix}`, ...args);
    debug: LogFn = (...args: any[]) => {
        if (this.showDebug) {
            console.debug(`${debugPrefix}`, ...args);
        }
    }
    trace: LogFn = (...args: any[]) => {
        if (this.showTrace) {
            console.trace(`${tracePrefix}`, ...args);
        }
    }
}

export const logger: Logger = new DefaultLogger(true);
