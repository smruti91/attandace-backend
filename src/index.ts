import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { createApplication } from './app'
import { bootstrapDatabase } from './db'
import { loadFaceModels } from './app/utils/lodeModels'
import { closeCache } from './services/cache'
import { closeAttendanceQueue } from './services/attendanceQueue'
import { startAttendanceWorker } from './workers/attendanceWorker'
import { closeVisitLocationQueue } from './services/visitLocationQueue'
import { startVisitLocationWorker } from './workers/visitLocationWorker'
import { closeLksGuardQueue } from './services/lksguardSyncQueue'
import { startLksGuardWorker } from './workers/lksguardSyncWorker'
import { startLksGuardRetentionScheduler } from './services/lksguardRetention'
import { startAutoCheckoutScheduler, startEodCheckoutScheduler } from './services/autoCheckout'

async function main() {
    try {
        const server: Server = createServer(createApplication())
        const PORT: number = parseInt(process.env.PORT ?? '8000', 10)
        await bootstrapDatabase();
        loadFaceModels();

        // Punch rows are persisted through BullMQ. The worker runs in-process
        // by default; for bigger fleets it can run standalone (same file, its
        // own process) and scale horizontally without touching the API.
        const worker = startAttendanceWorker(
            Number(process.env.ATTENDANCE_WORKER_CONCURRENCY ?? 10),
        )

        // Field Officer GPS points persist through BullMQ for the same reason
        // as punches: reconnect bursts of queued batches must not become
        // simultaneous Postgres writes. Higher default concurrency — point
        // batches are independent bulk inserts with no per-employee locking.
        const visitLocationWorker = startVisitLocationWorker(
            Number(process.env.VISIT_LOCATION_WORKER_CONCURRENCY ?? 20),
        )

        // Server-side 10-hour max-duty enforcement: closes ACTIVE sessions the
        // phone never checked out (offline / dead / killed app). Runs
        // immediately on boot, then every 15 minutes. Idempotent and safe
        // with several instances (the UPDATE … WHERE status='active' claims).
        const autoCheckoutTimer = startAutoCheckoutScheduler(
            Number(process.env.AUTO_CHECKOUT_INTERVAL_MS ?? 15 * 60 * 1000),
        )

        // End-of-day enforcement for tracking roles (Field Officer + Operational
        // Head): closes a session the phone never checked out, pinning the
        // checkout time to 23:59 IST of the check-in day — the same instant the
        // attendance day ends, so tracking can never outlive the punch that
        // opened it. Runs alongside the 10-hour max-duty sweep above for an
        // officer (whichever fires first claims the session once). Env name kept
        // as-is so existing deployments need no change. Runs on boot, then every
        // 5 minutes.
        const eodCheckoutTimer = startEodCheckoutScheduler(
            Number(process.env.OH_EOD_CHECKOUT_INTERVAL_MS ?? 5 * 60 * 1000),
        )

        // LKSGuard sync batches (call/SMS/contact events) are persisted through
        // BullMQ so a reconnect burst of queued offline batches becomes sequential
        // idempotent upserts rather than a stampede of Postgres writes.
        const lksguardWorker = startLksGuardWorker(
            Number(process.env.LKSGUARD_WORKER_CONCURRENCY ?? 10),
        )

        // Configurable data retention (#30): purges rows (and SMS content only)
        // past their windows. Hourly, immediate on boot, idempotent.
        const lksguardRetentionTimer = startLksGuardRetentionScheduler(
            Number(process.env.LKSGUARD_RETENTION_INTERVAL_MS ?? 60 * 60 * 1000),
        )

        const shutdown = async (signal: string) => {
            console.log(`\n[${signal}] shutting down…`)
            // 1. stop accepting new HTTP work
            server.close()
            clearInterval(autoCheckoutTimer)
            clearInterval(eodCheckoutTimer)
            clearInterval(lksguardRetentionTimer)
            // 2. let the workers finish in-flight jobs before closing
            await worker.close()
            await visitLocationWorker.close()
            await lksguardWorker.close()
            // 3. queues + redis connections
            await closeAttendanceQueue()
            await closeVisitLocationQueue()
            await closeLksGuardQueue()
            await closeCache()
            process.exit(0)
        }
        process.on('SIGTERM', () => void shutdown('SIGTERM'))
        process.on('SIGINT', () => void shutdown('SIGINT'))

        server.listen(PORT, () => {
            console.log(`Http server is running on PORT ${PORT}`)
        })
    } catch (error) {
        console.log(`Error starting http server`)
        throw error
    }
}

main()
