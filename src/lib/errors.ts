export interface SpecrErrorOptions extends ErrorOptions {
  readonly code?: string;
}

export class SpecrError extends Error {
  readonly code?: string;
  constructor(message: string, options?: SpecrErrorOptions) {
    super(message, options);
    this.name = this.constructor.name;
    if (options?.code !== undefined) this.code = options.code;
  }
}
