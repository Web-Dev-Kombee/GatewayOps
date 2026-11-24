import { db } from '../config/database';
import { ApiLog } from '../types';
import { LogsQueryParams } from '../dto/logs.dto';
import { PaginationMeta } from '../dto/pagination.dto';

export class LogsRepository {
  async findAll(params: LogsQueryParams & { page: number; limit: number }) {
    const { page, limit, service, statusCode, from, to, search } = params;

    let query = db('api_logs')
      .leftJoin('services', 'api_logs.service_id', 'services.id');

    if (service) {
      query = query.where('services.slug', service);
    }

    if (statusCode) {
      if (statusCode >= 1 && statusCode <= 9) {
        const min = statusCode * 100;
        const max = min + 99;
        query = query.whereBetween('api_logs.status_code', [min, max]);
      } else {
        query = query.where('api_logs.status_code', statusCode);
      }
    }

    if (from && to) {
      let fromDate = from;
      let toDate = to;
      if (/^\d{4}-\d{2}-\d{2}$/.test(from)) {
        fromDate = `${from}T00:00:00.000Z`;
      }
      if (/^\d{4}-\d{2}-\d{2}$/.test(to)) {
        toDate = `${to}T23:59:59.999Z`;
      } else if (from === to) {
        const d = new Date(to);
        d.setUTCHours(23, 59, 59, 999);
        toDate = d.toISOString();
      }
      query = query.whereBetween('api_logs.created_at', [fromDate, toDate]);
    }

    if (search) {
      query = query.where('api_logs.endpoint', 'like', `%${search}%`);
    }

    const total = await query.clone().count('api_logs.id as count').first() as any;
    const totalCount = parseInt(total?.count, 10) || 0;
    const offset = Math.max(0, (page - 1) * limit);

    const logs = await query
      .select('api_logs.*', 'services.name as service_name')
      .orderBy('api_logs.created_at', 'desc')
      .limit(limit)
      .offset(offset);

    return {
      logs: logs as ApiLog[],
      meta: {
        page,
        limit,
        total: totalCount,
        pages: Math.ceil(totalCount / limit),
      } as PaginationMeta,
    };
  }

  async findById(id: string): Promise<ApiLog | null> {
    return await db('api_logs').where('id', id).first();
  }
}
