use deadpool_sqlite::{Config, Runtime};

#[tokio::main]
async fn main() {
    let cfg = Config::new("test.db");
    let pool = cfg.builder(Runtime::Tokio1).unwrap().build().unwrap();
    let conn = pool.get().await.unwrap();
    conn.interact(|conn| {
        conn.execute("SELECT 1", []).unwrap();
    })
    .await
    .unwrap();
}
