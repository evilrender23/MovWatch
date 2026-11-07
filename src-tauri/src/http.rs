use std::time::Duration;

use reqwest::Client;

/// Navegador de escritorio: varios índices rechazan clientes desconocidos.
pub const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

/// Cliente para catálogos, buscadores y subtítulos: respuestas pequeñas, tiempo total acotado.
pub fn scraper_client() -> reqwest::Result<Client> {
    Client::builder()
        .user_agent(USER_AGENT)
        .cookie_store(true)
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(25))
        .build()
}
