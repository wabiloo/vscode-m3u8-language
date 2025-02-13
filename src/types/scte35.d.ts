declare module 'scte35' {
    export class SCTE35 {
        constructor();
        parseFromB64(base64: string): any;
        parseFromHex(hex: string): any;
    }
} 