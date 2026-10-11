//! Cross-language schema check only. This does not sign or grant promotion.
//! cargo run -p envelope --example check_rule_learning -- FILE CANDIDATE PARENT CORPUS NONCE
use envelope::rule_learning::RuleLearningEvidence;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 6 {
        return Err("usage: check_rule_learning FILE CANDIDATE PARENT CORPUS NONCE".into());
    }
    let file = std::fs::File::open(&args[1])?;
    if file.metadata()?.len() > 65_536 {
        return Err("fixture exceeds 64 KiB".into());
    }
    let fixture: serde_json::Value = serde_json::from_reader(file)?;
    let evidence: RuleLearningEvidence = serde_json::from_value(
        fixture
            .pointer("/accepted/ruleLearningEvidence")
            .ok_or("missing accepted evidence")?
            .clone(),
    )?;
    evidence.validate(&args[2], &args[3], &args[4], &args[5])?;
    println!("Evidence schema and thresholds passed; signed promotion not evaluated.");
    Ok(())
}
