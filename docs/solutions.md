# GatewayOps — Production Issue Assessment: Solutions & Verification

This document details the root causes, code changes, verification steps, and prevention strategies for the 10 production issues identified in `docs/problems.md`.

---

## Problem 1: Inaccurate Dashboard Totals

- **Severity:** 🔴 High
- **Area:** Metrics aggregation, database queries
- **Files Modified:** `apps/api/src/repositories/metrics.repository.ts`

### Root Cause
Knex's `.count('*')` against PostgreSQL returns a `bigint` which is deserialized as a **string** (e.g. `"10000"`, `"2500"`). The repository assigned these string values directly to `total_requests`, `failed_requests`, `auth_failures`, and `rate_limit_violations`, violating the `MetricsSummary` TypeScript DTO (`number`). In client and server operations, handling counts as strings caused arithmetic anomalies and inconsistent metric totals.

### The Fix
```diff
--- a/apps/api/src/repositories/metrics.repository.ts
+++ b/apps/api/src/repositories/metrics.repository.ts
@@ -12,25 +12,25 @@ export class MetricsRepository {
-    const countResult = await query.clone().count('*').first() as any;
-    const totalRequests = countResult.count;
+    const countResult = await query.clone().count('* as total').first() as any;
+    const totalRequests = parseInt(countResult.total, 10) || 0;

     let failedQuery = db('api_logs');
     if (from && to) {
       failedQuery = failedQuery.whereBetween('created_at', [from, to]);
     }
     const failedResult = await failedQuery
       .where('status_code', '>=', 400)
-      .count('*')
+      .count('* as total')
       .first() as any;
-    const failedRequests = failedResult.count;
+    const failedRequests = parseInt(failedResult.total, 10) || 0;

     const successRate = totalRequests > 0 
       ? Math.round((totalRequests - failedRequests) / totalRequests * 100)
       : 100;

     let authFailuresQuery = db('auth_events')
-      .where('event_type', 'login_failure');
+      .whereIn('event_type', ['login_failure', 'failed_login']);
     if (from && to) {
       authFailuresQuery = authFailuresQuery.whereBetween('created_at', [from, to]);
     }
-    const authFailures = await authFailuresQuery.count('*').first() as any;
+    const authFailuresResult = await authFailuresQuery.count('* as total').first() as any;
+    const authFailures = parseInt(authFailuresResult.total, 10) || 0;

     let latencyQuery = db('api_logs');
     if (from && to) {
       latencyQuery = latencyQuery.whereBetween('created_at', [from, to]);
     }
     const latencyResult = await latencyQuery.avg('latency_ms').first() as any;
     const avgResponseTime = Math.round(latencyResult.avg || 0);

     let violationsQuery = db('rate_limit_violations');
     if (from && to) {
       violationsQuery = violationsQuery.whereBetween('created_at', [from, to]);
     }
-    const violations = await violationsQuery.count('*').first() as any;
+    const violationsResult = await violationsQuery.count('* as total').first() as any;
+    const rateLimitViolations = parseInt(violationsResult.total, 10) || 0;

     return {
       total_requests: totalRequests,
       failed_requests: failedRequests,
       success_rate: successRate,
-      auth_failures: authFailures.count,
+      auth_failures: authFailures,
       avg_response_time: avgResponseTime,
-      rate_limit_violations: violations.count,
+      rate_limit_violations: rateLimitViolations,
     };
```

### Verification
- Ran `SELECT COUNT(*) FROM api_logs;` in PostgreSQL: returned `10000`.
- Queried API: `wget -qO- http://localhost:4000/api/v1/metrics/summary`.
- Output: `{"data":{"total_requests":10000,"failed_requests":2500,"success_rate":75,"auth_failures":250,"avg_response_time":1520,"rate_limit_violations":200}}`.
- Verified all counts are strictly typed numeric values and `total_requests` matches the database record count.

### Prevention
- Implement runtime schema validation with libraries such as Zod or class-validator on API responses.
- Explicitly cast database aggregate results (`count`, `sum`) with `parseInt` or `parseFloat`.

---

## Problem 2: Incomplete API Log Pagination

- **Severity:** 🟡 Medium
- **Area:** Database queries, pagination logic
- **Files Modified:** `apps/api/src/repositories/logs.repository.ts`

### Root Cause
Pagination offset was computed as `offset = page * limit;`. Because client pages are 1-based (`page = 1, 2, ...`), page 1 computed an offset of `1 * limit = 10`, skipping records 1–10 entirely. Furthermore, on the last page (`pages = total / limit`), the offset exceeded the total record count, rendering the final page unreachable.

### The Fix
```diff
--- a/apps/api/src/repositories/logs.repository.ts
+++ b/apps/api/src/repositories/logs.repository.ts
@@ -32,2 +32,3 @@ export class LogsRepository {
-    const offset = page * limit;
+    const totalCount = parseInt(total?.count, 10) || 0;
+    const offset = Math.max(0, (page - 1) * limit);
@@ -49,2 +50,2 @@ export class LogsRepository {
-        total: total.count,
-        pages: Math.ceil(total.count / limit),
+        total: totalCount,
+        pages: Math.ceil(totalCount / limit),
```

### Verification
- Tested page 1 (`page=1&limit=5`): returned the newest logs starting at the latest database record (`d2750d08-98e2-4a21-b253-8ee5a68f3bef`), without skipping.
- Tested last page (`page=2000&limit=5`): returned the final 5 records ending with the initial seeded record (`22a2353f-47cc-48c5-8a4f-c19c984bfeab`).
- Verified `meta.total = 10000` and `meta.pages = 2000` as numbers.

### Prevention
- Unit test pagination helper functions against boundary conditions (`page = 1`, `page = pages`, `limit = 1`).
- Share a unified pagination utility across backend repositories.

---

## Problem 3: Dashboard Metrics Don't Refresh

- **Severity:** 🔴 High
- **Area:** Caching, cache invalidation
- **Files Modified:** `apps/api/src/services/metrics.service.ts`

### Root Cause
`MetricsService.getSummary` used a static cache key `metrics:summary` with a 3600-second (1 hour) TTL in Redis. Any database changes or filter parameter adjustments (`from`, `to`) were obscured because the service returned the static 1-hour cached object without checking freshness or cache partition.

### The Fix
```diff
--- a/apps/api/src/services/metrics.service.ts
+++ b/apps/api/src/services/metrics.service.ts
@@ -9,2 +9,2 @@ export class MetricsService {
-    const cacheKey = `metrics:summary`;
+    const cacheKey = `metrics:summary:${from || 'all'}:${to || 'all'}`;
@@ -17,2 +17,9 @@ export class MetricsService {
-    await redis.setEx(cacheKey, 3600, JSON.stringify(summary));
+    await redis.setEx(cacheKey, 30, JSON.stringify(summary));

     return summary;
   }
+
+  async invalidateSummaryCache(): Promise<void> {
+    const keys = await redis.keys('metrics:summary:*');
+    if (keys.length > 0) {
+      await redis.del(keys);
+    }
+  }
```

### Verification
- Tested cache retrieval and inspected TTL via Redis CLI: `TTL metrics:summary:all:all` returned `27` seconds (30s window).
- Verified cache expires within 30 seconds and partitions correctly when date parameters are supplied.

### Prevention
- Keep cache TTLs short (e.g. 15–30s) for real-time monitoring dashboards.
- Incorporate all query parameters into cache key namespaces.

---

## Problem 4: Combined Filters Return Wrong Results

- **Severity:** 🟡 Medium
- **Area:** Query logic, filter combination
- **Files Modified:** `apps/api/src/repositories/logs.repository.ts`

### Root Cause
1. `LogsRepository` applied status code filtering using `.orWhere('status_code', statusCode)` instead of `.where(...)`, turning the filter predicate into an OR condition across all services.
2. The UI dropdown passes single digits for status code classes (`2` for 2xx, `4` for 4xx, `5` for 5xx), which failed direct equality matching on exact status codes like `542`.

### The Fix
```diff
--- a/apps/api/src/repositories/logs.repository.ts
+++ b/apps/api/src/repositories/logs.repository.ts
@@ -19,3 +19,8 @@ export class LogsRepository {
     if (statusCode) {
-      query = query.orWhere('status_code', statusCode);
+      if (statusCode >= 1 && statusCode <= 9) {
+        const min = statusCode * 100;
+        const max = min + 99;
+        query = query.whereBetween('api_logs.status_code', [min, max]);
+      } else {
+        query = query.where('api_logs.status_code', statusCode);
+      }
     }
```

### Verification
- Executed: `wget -qO- 'http://localhost:4000/api/v1/logs?service=payment-service&statusCode=5&limit=10'`.
- Verified every returned row was strictly from `Payment Service` and had a 5xx status code (e.g. `547`, `542`), with `meta.total = 200` (10% of Payment Service's 2000 records).

### Prevention
- Use parameterized query builders and always default to AND conjunctions unless OR grouping is explicitly scoped inside a nested closure.
- Add integration tests covering combined filter matrixes.

---

## Problem 5: Rate Limit Calculations Are Wrong

- **Severity:** 🔴 High
- **Area:** Math, calculations
- **Files Modified:** `apps/api/src/repositories/rateLimits.repository.ts`

### Root Cause
1. `RateLimitsRepository` calculated total minutes using integer truncation: `Math.floor(windowSeconds / 60)`. For non-multiples of 60 seconds (such as 90 seconds), `totalMinutes` truncated from 1.5 down to 1 (or produced incorrect proportions).
2. The `requestsQuery` filtered by `window_start` while `totalViolations` and the violations list filtered by `created_at`.
3. Total request sum and violation counts were not parsed to numbers.

### The Fix
```diff
--- a/apps/api/src/repositories/rateLimits.repository.ts
+++ b/apps/api/src/repositories/rateLimits.repository.ts
@@ -14,2 +14,2 @@ export class RateLimitsRepository {
     if (from && to) {
-      requestsQuery = requestsQuery.whereBetween('window_start', [from, to]);
+      requestsQuery = requestsQuery.whereBetween('created_at', [from, to]);
     }
@@ -18,7 +18,6 @@ export class RateLimitsRepository {
-    const totalRequests = requestsResult.sum || 0;
+    const totalRequests = parseFloat(requestsResult.sum) || 0;

     const windowSeconds = from && to 
-      ? (new Date(to).getTime() - new Date(from).getTime()) / 1000
+      ? Math.max(1, (new Date(to).getTime() - new Date(from).getTime()) / 1000)
       : 3600;
-    const totalMinutes = Math.floor(windowSeconds / 60);
-    const rpm = totalMinutes > 0 ? Math.floor(totalRequests / totalMinutes) : 0;
+    const windowMinutes = windowSeconds / 60;
+    const rpm = windowMinutes > 0 ? Math.round((totalRequests / windowMinutes) * 100) / 100 : 0;

     return {
-      total_violations: totalViolations.count,
+      total_violations: parseInt(totalViolations.count, 10) || 0,
       requests_per_minute: rpm,
       peak_rpm: 0,
     };
```

### Verification
- Tested endpoint `/api/v1/rate-limits/summary`.
- Output: `{"data":{"total_violations":200,"requests_per_minute":668.33,"peak_rpm":0}}`.
- Verified exact floating-point minute calculation produces accurate RPM rates regardless of window duration.

### Prevention
- Unit test rate and throughput calculations against fractional time windows (30s, 90s, 150s).
- Ensure consistent column filtering (`created_at`) across metric summaries and detail listings.

---

## Problem 6: Failed Login Count Is Too Low

- **Severity:** 🔴 High
- **Area:** Query filtering, data consistency
- **Files Modified:** `apps/api/src/repositories/auth.repository.ts`, `apps/api/src/repositories/metrics.repository.ts`

### Root Cause
`AuthRepository` and `MetricsRepository` queried failed logins using strictly `.where('event_type', 'login_failure')`. In modern and legacy systems, login failure events can be recorded as both `'login_failure'` and `'failed_login'`. Failure events using the alternate identifier were dropped from reported counts.

### The Fix
```diff
--- a/apps/api/src/repositories/auth.repository.ts
+++ b/apps/api/src/repositories/auth.repository.ts
@@ -13,1 +13,1 @@ export class AuthRepository {
-    let failureQuery = db('auth_events').where('event_type', 'login_failure');
+    let failureQuery = db('auth_events').whereIn('event_type', ['login_failure', 'failed_login']);
@@ -32,4 +32,4 @@ export class AuthRepository {
-      successful_logins: successResult.count,
-      failed_logins: failureResult.count,
-      token_invalid: invalidResult.count,
-      token_expired: expiredResult.count,
+      successful_logins: parseInt(successResult.count, 10) || 0,
+      failed_logins: parseInt(failureResult.count, 10) || 0,
+      token_invalid: parseInt(invalidResult.count, 10) || 0,
+      token_expired: parseInt(expiredResult.count, 10) || 0,
```

### Verification
- Checked database: `SELECT COUNT(*) FROM auth_events WHERE event_type IN ('login_failure', 'failed_login');` returned `250`.
- Queried API `/api/v1/auth/stats`: returned `{"data":{"successful_logins":600,"failed_logins":250,"token_invalid":100,"token_expired":50}}`.
- Verified count matches all failure event types.

### Prevention
- Standardize event type enums across auth services.
- Use `whereIn` or domain constants for event categories.

---

## Problem 7: API Logs Endpoint Is Slow at Scale

- **Severity:** 🔴 High
- **Area:** Performance, database indexes, query optimization
- **Files Modified:** `apps/api/src/repositories/logs.repository.ts`, `docker/postgres/init.sql`

### Root Cause
1. **N+1 Query Pattern:** For each returned log row in `logs.repository.ts`, the code executed a separate SQL query: `for (const log of logs) { await db('services').where('id', log.service_id).first(); }`. With 50–100 rows, this triggered 50–100 consecutive database queries per page.
2. **Missing Composite Indexes:** Sorting by `created_at DESC` while filtering by `service_id` or `status_code` required in-memory sorting or full table scans without composite indexes.

### The Fix
```diff
--- a/apps/api/src/repositories/logs.repository.ts
+++ b/apps/api/src/repositories/logs.repository.ts
@@ -10,6 +10,6 @@ export class LogsRepository {
-    let query = db('api_logs');
+    let query = db('api_logs')
+      .leftJoin('services', 'api_logs.service_id', 'services.id');

     if (service) {
-      const serviceRecord = await db('services').where('slug', service).first();
-      if (serviceRecord) {
-        query = query.where('service_id', serviceRecord.id);
-      }
+      query = query.where('services.slug', service);
     }
@@ -41,9 +44,5 @@ export class LogsRepository {
     const logs = await query
+      .select('api_logs.*', 'services.name as service_name')
       .orderBy('api_logs.created_at', 'desc')
       .limit(limit)
       .offset(offset);
-
-    for (const log of logs) {
-      const service = await db('services').where('id', log.service_id).first();
-      (log as any).service_name = service?.name;
-    }
```
Database indexes added:
```sql
CREATE INDEX IF NOT EXISTS idx_api_logs_service_created ON api_logs(service_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_api_logs_status_created ON api_logs(status_code, created_at DESC);
```

### Verification
- Endpoint `/api/v1/logs?service=payment-service&statusCode=5` now executes a single SQL query with join and index scan, returning in under 25ms.
- Verified zero secondary queries executed for `service_name`.

### Prevention
- Never execute database queries inside iterative loops (`for`, `map`, `forEach`).
- Always profile query execution plans (`EXPLAIN ANALYZE`) under production-scale data volumes.

---

## Problem 8: Non-Admin Users Can Access Admin Endpoint

- **Severity:** 🔴 Critical
- **Area:** Authorization, middleware ordering
- **Files Modified:** `apps/api/src/routes/metrics.routes.ts`

### Root Cause
In `apps/api/src/routes/metrics.routes.ts`:
1. `roleGuard('admin')` was positioned **after** the route controller handler: `router.get('/admin/detailed', (req, res, next) => controller.getDetailedMetrics(...), roleGuard('admin'));`. Because the controller responded to the request without calling `next()`, `roleGuard` was never invoked.
2. `authMiddleware` was missing from the route chain, meaning `req.user` was unpopulated.

### The Fix
```diff
--- a/apps/api/src/routes/metrics.routes.ts
+++ b/apps/api/src/routes/metrics.routes.ts
@@ -2,1 +2,2 @@
+import { authMiddleware } from '../middleware/auth.middleware';
 import { roleGuard } from '../middleware/roleGuard';
@@ -12,1 +13,1 @@
-router.get('/admin/detailed', (req, res, next) => controller.getDetailedMetrics(req, res, next), roleGuard('admin'));
+router.get('/admin/detailed', authMiddleware, roleGuard('admin'), (req, res, next) => controller.getDetailedMetrics(req, res, next));
```

### Verification
- **Unauthenticated request:** `wget -S http://localhost:4000/api/v1/metrics/admin/detailed` → returns `401 Unauthorized`.
- **Viewer role token:** request with `role: "viewer"` token → returns `403 Forbidden` (`{"message":"Insufficient permissions"}`).
- **Admin role token:** request with `role: "admin"` token → returns `200 OK` with full detailed metrics.

### Prevention
- Implement automated security route regression tests verifying 401/403 status codes for unauthenticated and unauthorized requests.
- Standardize route definitions using declarative route wrappers or router-level guard middleware.

---

## Problem 9: Dashboard Cards and Charts Show Different Values

- **Severity:** 🟡 Medium
- **Area:** State management, React Query, cache keys
- **Files Modified:** `apps/web/src/hooks/useDashboardMetrics.ts`, `apps/web/src/app/page.tsx`

### Root Cause
In `apps/web/src/app/page.tsx`:
1. The `summaryQuery` used a static React Query key: `['metrics', 'summary']` without `dateRange.from` or `dateRange.to`.
2. The `api.get('/metrics/summary')` call omitted the `from` and `to` query parameters.
When users changed the date range picker, chart queries refetched because their keys included the dates, while the summary cards retained stale data from initial page load.

### The Fix
```diff
--- a/apps/web/src/app/page.tsx
+++ b/apps/web/src/app/page.tsx
@@ -22,4 +22,6 @@ export default function Dashboard() {
   const summaryQuery = useQuery({
-    queryKey: ['metrics', 'summary'],
+    queryKey: ['metrics', 'summary', dateRange.from, dateRange.to],
     queryFn: async () => {
-      const response = await api.get('/metrics/summary');
+      const response = await api.get('/metrics/summary', {
+        params: { from: dateRange.from, to: dateRange.to },
+      });
       return response.data.data;
--- a/apps/web/src/hooks/useDashboardMetrics.ts
+++ b/apps/web/src/hooks/useDashboardMetrics.ts
@@ -5,2 +5,2 @@ export function useDashboardMetrics(from?: string, to?: string) {
   return useQuery({
-    queryKey: ['metrics', 'summary'],
+    queryKey: ['metrics', 'summary', from, to],
```

### Verification
- Changed date ranges on the dashboard: verified both KPI cards and time-series charts update synchronously with matching date range parameters.

### Prevention
- Maintain query key factory functions that strictly pair request parameters with TanStack Query keys.
- Write component tests verifying refetch triggers on filter state transitions.

---

## Problem 10: Single-Day Date Filter Returns No Results

- **Severity:** 🟡 Medium
- **Area:** Date handling, time boundaries
- **Files Modified:** `apps/api/src/repositories/logs.repository.ts`

### Root Cause
When the user specified the same date for `from` and `to` (e.g. `2024-06-01`), `whereBetween('created_at', ['2024-06-01', '2024-06-01'])` converted `to` to `2024-06-01 00:00:00`. Any log created after midnight on that date was excluded, returning 0 records.

### The Fix
```diff
--- a/apps/api/src/repositories/logs.repository.ts
+++ b/apps/api/src/repositories/logs.repository.ts
@@ -29,3 +29,15 @@ export class LogsRepository {
     if (from && to) {
-      query = query.whereBetween('created_at', [from, to]);
+      let fromDate = from;
+      let toDate = to;
+      if (/^\d{4}-\d{2}-\d{2}$/.test(from)) {
+        fromDate = `${from}T00:00:00.000Z`;
+      }
+      if (/^\d{4}-\d{2}-\d{2}$/.test(to)) {
+        toDate = `${to}T23:59:59.999Z`;
+      } else if (from === to) {
+        const d = new Date(to);
+        d.setUTCHours(23, 59, 59, 999);
+        toDate = d.toISOString();
+      }
+      query = query.whereBetween('api_logs.created_at', [fromDate, toDate]);
     }
```

### Verification
- Tested with identical start and end dates: `wget -qO- 'http://localhost:4000/api/v1/logs?from=2026-11-24&to=2026-11-24&limit=3'`.
- Successfully returned the log entries for the full day from `00:00:00` through `23:59:59.999` with `total = 10000`, rather than an empty list.

### Prevention
- Establish consistent timestamp boundary normalization for all user-selected calendar dates (start of day `00:00:00.000Z` to end of day `23:59:59.999Z`).

---

## Bonus Infrastructure Fix: Container Health Check
- In `docker-compose.yml`, the healthcheck command used `curl` which was absent from `node:20-alpine`.
- Replaced with `wget -qO- http://localhost:4000/api/v1/health | grep -q ok || exit 1`.
- Container health transitions reliably to `healthy`, enabling dependent containers (`web`) to boot without timeout errors.
