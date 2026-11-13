export function maskedStream(secrets: string[], write: (text: string) => void): {data(value:Buffer):void;end():void};
