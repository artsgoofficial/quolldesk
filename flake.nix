{
  description = "QuollDesk packages";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs =
    { self, nixpkgs }:
    let
      supportedSystems = [
        "x86_64-linux"
        "aarch64-linux"
      ];

      forAllSystems = nixpkgs.lib.genAttrs supportedSystems;
    in
    {
      packages = forAllSystems (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
        in
        rec {
          quolldesk = pkgs.callPackage ./nix/package.nix { };
          default = quolldesk;
        }
      );

      apps = forAllSystems (system: {
        quolldesk = {
          type = "app";
          program = "${nixpkgs.lib.getExe self.packages.${system}.quolldesk}";
        };
        default = self.apps.${system}.quolldesk;
      });
    };
}
