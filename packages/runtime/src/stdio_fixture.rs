use std::io::{self, BufRead, Write};

fn main() -> io::Result<()> {
    let stdin = io::stdin();
    let mut stdout = io::BufWriter::new(io::stdout().lock());
    for line in stdin.lock().lines() {
        writeln!(stdout, "{}", line?)?;
        stdout.flush()?;
    }
    Ok(())
}
