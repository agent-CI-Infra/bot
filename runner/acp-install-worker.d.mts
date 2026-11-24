export function stageAcpSource(source: string, target?: string): string;

export interface BuildWorkSwarmOptions {
  root?: string;
  product: string;
  version: string;
  sourceDir: string;
  pythonExecutable?: string;
  uvExecutable?: string;
  offline?: boolean;
}

export function buildWorkSwarmProduct(options: BuildWorkSwarmOptions): unknown;
