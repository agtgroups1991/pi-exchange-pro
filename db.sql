create table if not exists users(uid text primary key, username text, is_admin boolean default false, is_operator boolean default false, accepted_terms boolean default false, created_at timestamptz default now(), updated_at timestamptz default now());
create table if not exists balances(uid text references users(uid), asset text, amount numeric default 0, primary key(uid,asset));
create table if not exists pairs(id serial primary key, base_asset text not null, quote_asset text not null, symbol text unique);
insert into pairs(base_asset,quote_asset,symbol) values ('USDX','PI','USDX/PI') on conflict(symbol) do nothing;
create table if not exists payments(payment_id text primary key, uid text references users(uid), amount numeric, status text, txid text, created_at timestamptz default now(), completed_at timestamptz);
create table if not exists orders(id text primary key, uid text references users(uid), pair_id int references pairs(id), side text, price numeric, qty numeric, filled numeric default 0, status text, created_at timestamptz default now());
create table if not exists trades(id text primary key, pair_id int references pairs(id), price numeric, qty numeric, maker_side text, buy_order_id text references orders(id), sell_order_id text references orders(id), taker_uid text, maker_uid text, fee_pi numeric default 0, ts timestamptz default now());
create table if not exists withdrawals(id text primary key, uid text references users(uid), asset text default 'PI', amount numeric, pi_address text, status text, note text, created_at timestamptz default now(), updated_at timestamptz default now());
create table if not exists audit(id text primary key, ts timestamptz default now(), event text, payload jsonb);
