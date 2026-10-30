# Changelog

Release notes for the Review appliance. New sections are drafted with git-cliff
and reviewed in the version-bump pull request.

## [0.1.8]

### Bug Fixes

- **review**: retain issue PR-ready ownership (#111) ([959fc99](https://github.com/joshyorko/review/commit/959fc9992d6abf8eba3d96706eadbc76d59e5591))

## [0.1.7]

### Bug Fixes

- **review**: restore structured workbench outcomes (#94) ([ad0a9c4](https://github.com/joshyorko/review/commit/ad0a9c40c9f3eedbd907e051ccf8de6662bb2e82))
- make the unused MemoryD shim opt-in at build time (#98) ([5d1b5ae](https://github.com/joshyorko/review/commit/5d1b5ae2df33992b7ef02ac50e2d19b01304befa))
- refresh OMP lifecycle patch context for 18.14 (#102) ([41704bf](https://github.com/joshyorko/review/commit/41704bfb78c566003c5b631435de2af871d4be4c))
- **ci**: select upstream Apptainer package on Ubuntu 26 (#99) ([66d6135](https://github.com/joshyorko/review/commit/66d613524c884d430a22587abec01f346f8f3c64))
- package manifest-declared Review skill resources (#100) ([8f684eb](https://github.com/joshyorko/review/commit/8f684ebb31f10e327c565fd848e9d1429d1d7a59))
- **release**: draft notes from published stable ancestor (#103) ([0200480](https://github.com/joshyorko/review/commit/0200480e9972b95b3cf30be94d617ae9188f2ad0))
- **ci**: match release PR head owner in validation guard (#107) ([1d4b63c](https://github.com/joshyorko/review/commit/1d4b63ce66b70cfb75ed4cd430981ae621641980))

### Dependencies

- **deps**: update dependency platformdirs to v4.14.0 (#92) ([761e0a6](https://github.com/joshyorko/review/commit/761e0a67dea89837bd48014ac61744292a239c84))
- **deps**: update dependency nodeenv to v1.11.1 (#96) ([13980b3](https://github.com/joshyorko/review/commit/13980b37440ab0518bb955bb5fe1cd08f52464b6))
- **deps**: update dependency node to v26 (#101) ([0907b39](https://github.com/joshyorko/review/commit/0907b39dfea7ae3f534ca0088d235c9279dc2139))
- **deps**: update dependency can1357/oh-my-pi to v18.14.0 (#95) ([bd510f8](https://github.com/joshyorko/review/commit/bd510f804962a600f11de3bd020e68f52dafaead))

### Refactoring

- remove optional Hive connector (#104) ([028f37b](https://github.com/joshyorko/review/commit/028f37b91702b89690367bc212ab68da15ed447f))

## [0.1.6]

### Bug Fixes

- **review**: restore structured workbench outcomes (#94) ([ad0a9c4](https://github.com/joshyorko/review/commit/ad0a9c40c9f3eedbd907e051ccf8de6662bb2e82))

### Dependencies

- **deps**: update dependency platformdirs to v4.14.0 (#92) ([761e0a6](https://github.com/joshyorko/review/commit/761e0a67dea89837bd48014ac61744292a239c84))
- **deps**: update dependency nodeenv to v1.11.1 (#96) ([13980b3](https://github.com/joshyorko/review/commit/13980b37440ab0518bb955bb5fe1cd08f52464b6))

## [0.1.5]

### Dependencies

- **deps**: update dependency python-discovery to v1.6.7 (#87) ([2e392f0](https://github.com/joshyorko/review/commit/2e392f0f85e4c6a1b97e5045f5b24daf78d27a77))
- **deps**: update dependency platformdirs to v4.13.7 (#86) ([82cd47e](https://github.com/joshyorko/review/commit/82cd47e00ff581f85a8dec5a08b61c08235d83ea))
- **deps**: update dependency virtualenv to v21.15.1 (#85) ([653435e](https://github.com/joshyorko/review/commit/653435e053f5f992e27e84ebaf5d46b7955ed77c))
- **deps**: schedule OMP patches weekly (#90) ([92e68f5](https://github.com/joshyorko/review/commit/92e68f5044fa3f6f6eb8c335452d54511731021c))
- **deps**: update ewatercycle/setup-apptainer action to v3 (#89) ([fe42d57](https://github.com/joshyorko/review/commit/fe42d5785a4d723a4651208d8ce920338d0c457f))
- **deps**: update dependency can1357/oh-my-pi to v18.13.3 (#88) ([d10b565](https://github.com/joshyorko/review/commit/d10b565f805b52c3f15facee0a2cefd3716c8fd9))
- **deps**: update dependency node to v26 (#84) ([429d486](https://github.com/joshyorko/review/commit/429d4865af39aef6c491e2cf79e6caf0738b08ac))

## [0.1.4]

### Bug Fixes

- **factory**: qualify typed-graph convergence and request accounting (#73) ([ece575e](https://github.com/joshyorko/review/commit/ece575e0f9a17689d2402683b82ba3ae8dddc65f))
- make release version requests reviewable (#74) ([168b0a9](https://github.com/joshyorko/review/commit/168b0a95623e56491a9fc0a6cf6c974db09ce45c))

### Dependencies

- **deps**: update dependency can1357/oh-my-pi to v18.13.2 (#76) ([b61e048](https://github.com/joshyorko/review/commit/b61e0486080a7fdc2602e1d0394a54fd8ba4aa88))
- **deps**: update dependency python-discovery to v1.6.6 (#78) ([0255b15](https://github.com/joshyorko/review/commit/0255b159bececf4e1afeb909c45c173728b1f12e))

### Features

- connect release changelogs and add offline CLI viewer (#81) ([0a947fe](https://github.com/joshyorko/review/commit/0a947fe550d7e5632f9187147022d18e722ab93d))
- **review**: support solo and team policy with safe Slay recovery (#80) ([98336ec](https://github.com/joshyorko/review/commit/98336ec2c881cc65c4b347c824a3dea5ba7c5286))

## [0.1.3]

Published before automated changelog generation was connected.
See the [original release](https://github.com/joshyorko/review/releases/tag/v0.1.3)
for its artifacts and provenance.
