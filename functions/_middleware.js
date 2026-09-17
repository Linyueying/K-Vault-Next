/**
 * 全局中间件
 * 只处理错误和遥测，不做认证（认证由 /api/manage/_middleware.js 处理）
 */
import { errorHandling, telemetryData } from './utils/middleware';

export const onRequest = [errorHandling, telemetryData];
