import { type PaidData, type PremiumData, type Product } from "./model.js";
export declare function createReportPdf({ data, product, companyKey, previous, paid }: {
    data: PremiumData;
    product: Product;
    companyKey: string;
    previous?: PremiumData;
    paid?: PaidData;
}): Promise<Uint8Array<ArrayBufferLike>>;
