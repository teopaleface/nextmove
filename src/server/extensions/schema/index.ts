// Extension tables, applied after the core bank schema. Kept free of other imports so the DB layer can load it.
import { cancellationGuaranteeSchema } from "./cancellation-guarantee";
import { exitPlanSchema } from "./exit-plan";
import { retentionOffersSchema } from "./retention-offers";
import { merchantInsightsSchema } from "./merchant-insights";
import { priceGateSchema } from "./price-gate";
import { cardReissueSchema } from "./card-reissue";
import { businessMoveSchema } from "./business-move";
import { certificateSchema } from "./certificate";
import { sharedSplitSchema } from "./shared-split";

export const EXT_SCHEMA = [cancellationGuaranteeSchema, exitPlanSchema, retentionOffersSchema, merchantInsightsSchema, priceGateSchema, cardReissueSchema, businessMoveSchema, certificateSchema, sharedSplitSchema].join("\n");
