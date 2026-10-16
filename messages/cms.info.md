# summary

Show offline CMS contract and capability information.

# description

Reports the current public command inventory, result contracts, operation-specific support, and tested API baseline without contacting an org. Portable Email and Email Template deploy and loose-image upload remain unqualified. Retained family registry declarations are labelled internal-engine-only: they do not advertise public retrieve/deploy availability. Image deployment and deferred baseline/sibling integration are not supported public capabilities.

# examples

- Show the installed plugin's current offline capability envelope:

  <%= config.bin %> <%= command.id %> --json

# flags.contract-version.summary

Current machine contract major (supported: 1).
