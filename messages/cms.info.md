# summary

Show offline CMS contract and capability information.

# description

Reports the versioned CLI JSON contracts, package compatibility, tested API baseline, and truthfully evidenced CMS capabilities without contacting an org.

# examples

- Show the installed plugin's offline capability envelope:

  <%= config.bin %> <%= command.id %> --json

- Explicitly select supported command-result major 1:

  <%= config.bin %> <%= command.id %> --contract-version 1 --json

# flags.contract-version.summary

Machine contract major version (supported: 1).
