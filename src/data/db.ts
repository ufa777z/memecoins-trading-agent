import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(__dirname, '../../data/trench.db');

import fs from 'fs';
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_address TEXT NOT NULL,
    token_symbol TEXT,
    entry_price REAL,
    entry_sol REAL,
    entry_time INTEGER,
    exit_price REAL,
    exit_sol REAL,
    exit_time INTEGER,
    pnl_sol REAL,
    pnl_percent REAL,
    status TEXT,
    exit_reason TEXT,
    signal_wallets TEXT,
    wallet_count INTEGER,
    composite_score REAL,
    score_volume REAL,
    score_holders REAL,
    score_dev REAL,
    score_distribution REAL,
    score_ct REAL,
    ct_motion INTEGER
  );

  CREATE TABLE IF NOT EXISTS wallet_trust (
    wallet TEXT PRIMARY KEY,
    trust REAL DEFAULT 1.0,
    updated_at INTEGER
  );
`);

export interface Trade {
  id?: number;
  token_address: string;
  token_symbol: string;
  entry_price: number;
  entry_sol: number;
  entry_time: number;
  exit_price?: number;
  exit_sol?: number;
  exit_time?: number;
  pnl_sol?: number;
  pnl_percent?: number;
  status: string;
  exit_reason?: string;
  signal_wallets: string;
  wallet_count: number;
  composite_score: number;
  score_volume: number;
  score_holders: number;
  score_dev: number;
  score_distribution: number;
  score_ct: number;
  ct_motion: number;
}

export const TradeDB = {
  insert(t: Omit<Trade, 'id'>): number {
    const stmt = db.prepare(`
      INSERT INTO trades (
        token_address, token_symbol, entry_price, entry_sol, entry_time, status,
        signal_wallets, wallet_count, composite_score,
        score_volume, score_holders, score_dev, score_distribution, score_ct, ct_motion
      ) VALUES (
        @token_address, @token_symbol, @entry_price, @entry_sol, @entry_time, @status,
        @signal_wallets, @wallet_count, @composite_score,
        @score_volume, @score_holders, @score_dev, @score_distribution, @score_ct, @ct_motion
      )
    `);
    const info = stmt.run(t);
    return Number(info.lastInsertRowid);
  },

  updateExit(
    id: number,
    data: {
      exit_price: number;
      exit_sol: number;
      exit_time: number;
      pnl_sol: number;
      pnl_percent: number;
      status: string;
      exit_reason: string;
    }
  ): void {
    db.prepare(
      `UPDATE trades SET exit_price=@exit_price, exit_sol=@exit_sol, exit_time=@exit_time,
       pnl_sol=@pnl_sol, pnl_percent=@pnl_percent, status=@status, exit_reason=@exit_reason WHERE id=@id`
    ).run({ ...data, id });
  },

  getAll(): Trade[] {
    return db.prepare('SELECT * FROM trades ORDER BY id DESC').all() as Trade[];
  },

  stats(): { total: number; winRate: number; totalPnl: number } {
    const rows = db
      .prepare(`SELECT pnl_sol FROM trades WHERE status = 'closed' AND pnl_sol IS NOT NULL`)
      .all() as { pnl_sol: number }[];
    const total = rows.length;
    const wins = rows.filter((r) => r.pnl_sol > 0).length;
    const totalPnl = rows.reduce((s, r) => s + r.pnl_sol, 0);
    return {
      total,
      winRate: total ? Math.round((wins / total) * 1000) / 10 : 0,
      totalPnl: Math.round(totalPnl * 1000) / 1000,
    };
  },

  getWalletTrust(wallet: string): number {
    const row = db.prepare('SELECT trust FROM wallet_trust WHERE wallet = ?').get(wallet) as
      | { trust: number }
      | undefined;
    return row?.trust ?? 1.0;
  },

  setWalletTrust(wallet: string, trust: number): void {
    db.prepare(
      `INSERT INTO wallet_trust (wallet, trust, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(wallet) DO UPDATE SET trust = excluded.trust, updated_at = excluded.updated_at`
    ).run(wallet, trust, Date.now());
  },
};

export const SignalDB = {
  log(_token: string, _wallet: string, _tx: string, _sol: number): void {
    // optional signal log table later
  },
};
