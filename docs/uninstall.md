# Uninstall

Preview owned resources:

```bash
wco uninstall --purge
```

Confirm local data removal:

```bash
wco uninstall --purge --yes
```

The interactive command is `/uninstall`; `/unitsall` is accepted as an alias. WCO removes only its canonical home or separately re-attested managed worktrees. It refuses broad paths, symlinks, any path overlapping a registered source repository, and dirty/ambiguous worktrees. It never deletes source repositories, Git history, remote branches, pull requests or deployments. Source checkouts and ambiguous npm links must be removed explicitly by the user.
