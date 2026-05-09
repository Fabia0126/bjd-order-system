-- BJD订单系统数据库表结构
-- 在Supabase SQL Editor中运行此脚本

-- 订单表
CREATE TABLE orders (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    order_id TEXT,
    status TEXT DEFAULT 'pending',
    order_type TEXT,
    size TEXT,
    makeup_type TEXT,
    doll_info TEXT,
    attribute TEXT,
    gender TEXT,
    color_scheme TEXT,
    taboos TEXT[],
    requirements TEXT[],
    addons TEXT[],
    free_items TEXT[],
    glitter TEXT,
    accessories TEXT,
    xianyu_id TEXT,
    receiver_name TEXT,
    contact1 TEXT,
    contact2 TEXT,
    shipping TEXT,
    total_price TEXT,
    mianwen_price INTEGER,
    submit_time TIMESTAMPTZ DEFAULT NOW(),
    last_update TIMESTAMPTZ DEFAULT NOW()
);

-- 设置表
CREATE TABLE settings (
    id INTEGER PRIMARY KEY DEFAULT 1,
    normal_open BOOLEAN DEFAULT true,
    normal_limit INTEGER DEFAULT 0,
    normal_open_time TIMESTAMPTZ,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 插入默认设置
INSERT INTO settings (id, normal_open, normal_limit) VALUES (1, true, 0);

-- 启用实时订阅（可选，用于实时更新）
ALTER PUBLICATION supabase_realtime ADD TABLE orders;
ALTER PUBLICATION supabase_realtime ADD TABLE settings;

-- 设置Row Level Security（允许匿名读写）
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE settings ENABLE ROW LEVEL SECURITY;

-- 允许所有人读写订单（生产环境建议加限制）
CREATE POLICY "Allow all access to orders" ON orders FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all access to settings" ON settings FOR ALL USING (true) WITH CHECK (true);
