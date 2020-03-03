import connect from "../../../../renderer/screens/helpers/connect";
import {Terminal} from "xterm";
import React, { Component } from "react";
import NodeLink from "../components/NodeLink";
import CordAppLink from "../components/CordAppLink";
import TransactionLink from "../components/TransactionLink";
import TransactionData from "../transaction-data";
import { ipcRenderer } from "electron";
require("xterm/css/xterm.css");

// this is taken from braid
const VERSION_REGEX = /^(.*?)(?:-(?:(?:\d|\.)+))\.jar?$/;

function filterNodeBy(nodeToMatch) {
  return (node) => {
    return node.safeName === nodeToMatch;
  }
}

class NodeDetails extends Component {
  constructor(props) {
    super(props);

    this.state = {node: this.findNodeFromProps(), nodes:null, notaries:null, cordapps: null, transactions: null};
    this.xtermRef = React.createRef();
    this.term = new Terminal();
  }

  findNodeFromProps(){
    const workspace = this.props.config.settings.workspace;
    const isNode = filterNodeBy(this.props.match.params.node);
    let matches = [...workspace.nodes, ...workspace.notaries].filter(isNode);
    return matches[0] || null;
  }

  componentDidMount(){
    this.refresh();
    // TODO-NICK: not sure if componentDidMount is the right place for this?
    // maybe it is. /shrug
    this.term.open(this.xtermRef.current);
    const safeName = this.state.node.safeName
    const term = this.term;
    ipcRenderer.on("sshData", (_event, {node, data}) => {
      if (node !== safeName) return;
      term.write(data);
    });
    term.onData(data => {
      ipcRenderer.send("xtermData", {node: safeName, data});
    });
  }

  componentDidUpdate(prevProps) {
    if (prevProps.match.params.node !== this.props.match.params.node) {
      this.setState({node: this.findNodeFromProps(), nodes:null, notaries:null, cordapps:null, transactions: null}, this.refresh.bind(this));
    }
    if (prevProps.config.updated !== this.props.config.updated) {
      this.refresh();
    }
  }

  refresh() {
    if (this.state.node) {
      const nodes = this.props.config.settings.workspace.nodes;
      const postgresPort =  this.props.config.settings.workspace.postgresPort;

      const notariesProm = fetch("https://localhost:" + (this.state.node.braidPort) + "/api/rest/network/notaries")
        .then(r => r.json()).then(json => {
          if(Array.isArray(json)) return json;
          return [];
        })

      notariesProm.then(notaries => this.setState({notaries}));

      fetch("https://localhost:" + (this.state.node.braidPort) + "/api/rest/network/nodes")
        .then(r => r.json())
        .then(json => {
          if(Array.isArray(json)) return json;
          return [];
        })
        .then(async nodes => {
          const selfName = this.state.node.name.replace(/\s/g, "");
          const notaries = await notariesProm;
          const notariesMap = new Set(notaries.map(notary => notary.owningKey));
          const nodesMap = new Map();
          nodes.forEach(node => {
            return node.legalIdentities.some(nodeIdent => {
              // braid sometimes returns the same node multiple times
              if (nodesMap.has(nodeIdent.owningKey)) return;

              // filter out self
              if (nodeIdent.name.replace(/\s/g,"") === selfName) {
                return false;
              } else {
                // filter out notaries
                if(!notariesMap.has(nodeIdent.owningKey)){
                  nodesMap.set(nodeIdent.owningKey, node);
                }
              }
            });
          });
          this.setState({nodes: [...nodesMap.values()]});
        });

      fetch("https://localhost:" + (this.state.node.braidPort) + "/api/rest/cordapps")
        .then(r => r.json())
        .then(json => {
          if(Array.isArray(json)) return json;
          return [];
        })
        .then(cordapps => this.setState({cordapps}));

      fetch("https://localhost:" + (this.state.node.braidPort) + "/api/rest/network/nodes/self")
        .then(r => r.json())
        .then(self => {
          fetch("https://localhost:" + (this.state.node.braidPort) + "/api/rest/vault/vaultQueryBy", {
            method: "POST",
            headers: {
              "accept": "application/json",
              "content-type": "application/json"
            },
            body: JSON.stringify({
              "criteria" : {
                "@class" : ".QueryCriteria$VaultQueryCriteria",
                "status" : "ALL",
                "participants" : self.legalIdentities
              }
            })
          })
          .then(res => res.json())
          .then(json => {
            if (json && Array.isArray(json.states)) return json;
            return [];
          })
          .then(json => {
            const transactionPromises = [];
            const hashes = new Set();
            json.states.forEach(state => {
              hashes.add(state.ref.txhash);
            });
            hashes.forEach(hash => {
              const tx = new TransactionData(hash);
              transactionPromises.push(tx.update(nodes, postgresPort));
            })
            return Promise.all(transactionPromises);
          }).then(transactions => {
            this.setState(state => {
              return {transactions: [...state.transactions || [], ...transactions]};
            });
          })
        });

      TransactionData.getConnectedClient(this.state.node.safeName, this.props.config.settings.workspace.postgresPort)
        .then(async client => {
          try {
            return await client.query("SELECT transaction_id FROM node_notary_committed_txs");
          } finally {
            client.release();
          }
        }).then(async res => {
          const proms = Promise.all(res.rows.map(row => {
            const tx = new TransactionData(TransactionData.convertTransactionIdToHash(row.transaction_id));
            return tx.update(nodes, postgresPort);
          }));
          
          const transactions = await proms;
          this.setState(state => {
            return {transactions: [...(state.transactions || []), ...transactions]};
          });
        }).catch(e => {
          console.log("probably not a notary :-)", e);
        })
    }
  }

  getWorkspaceNode(owningKey){
    return this.props.config.settings.workspace.nodes.find(node => owningKey === node.owningKey);
  }

  getWorkspaceNotary(owningKey){
    return this.props.config.settings.workspace.notaries.find(notary => owningKey === notary.owningKey);
  }

  getWorkspaceCordapp(name) {
    return this.props.config.settings.workspace.projects.find(cordapp => VERSION_REGEX.exec(cordapp)[1].toLowerCase().endsWith(name.toLowerCase()));
  }

  getCordapps(){
    let cordapps = (<div className="Waiting Waiting-Padded">Loading CorDapps...</div>);
    if(this.state.cordapps) {
      cordapps = this.state.cordapps.reduce((acc, cordapp) => {
        const workspaceCordapp = this.getWorkspaceCordapp(cordapp);
        if (workspaceCordapp) {
          acc.push((<CordAppLink key={workspaceCordapp} cordapp={workspaceCordapp} workspace={this.props.config.settings.workspace}>{workspaceCordapp}</CordAppLink>));
        }
        return acc;
      }, []);
      if (cordapps.length === 0) {
        cordapps = (<div className="Waiting Waiting-Padded">No CorDapps</div>);
      }
    }
    return cordapps;
  }

  getConnectedNodes(){
    const loading = (<div className="Waiting Waiting-Padded">Loading Nodes &amp; Notaries...</div>);
    const noPeers = (<div className="Waiting Waiting-Padded">No Node &amp; Notary peers...</div>);
    let nodes = [];
    let hasNoPeers = (!!this.state.nodes && !!this.state.notaries);
    if (this.state.nodes) {
      nodes = this.state.nodes.reduce((acc, node) => {
        const owningKey = node.legalIdentities[0].owningKey
        // filter self
        if (this.state.node.owningKey === owningKey) return acc;

        const workspaceNode = this.getWorkspaceNode(owningKey);
        if (workspaceNode) {
          acc.push((<NodeLink key={`node-${workspaceNode.safeName}`} postgresPort={this.props.config.settings.workspace.postgresPort} node={workspaceNode} />));
        }
        return acc;
      }, []);
    }
    if (this.state.notaries) {
      nodes = nodes.concat(this.state.notaries.reduce((acc, notary) => {
        const owningKey = notary.owningKey
        // filter self
        if (this.state.node.owningKey === owningKey) return acc;

         const workspaceNode = this.getWorkspaceNotary(notary.owningKey);
        if (workspaceNode && notary.owningKey !== this.state.node) {
          acc.push((<NodeLink key={`node-${workspaceNode.safeName}`} postgresPort={this.props.config.settings.workspace.postgresPort} node={workspaceNode} services={["Notary"]} />));
        }
        return acc;
      }, []));
    }
    return nodes.length ? nodes : hasNoPeers ? noPeers : loading;
  }

  getTransactions(){
    let noTxsOrLoading;
    let txs;
    const seen = new Set();
    if (this.state.transactions){
      if (this.state.transactions.length === 0) {
        noTxsOrLoading = (<div className="Waiting Waiting-Padded">No Transactions</div>);
      } else {
        txs = this.state.transactions.sort((a, b) => b.earliestRecordedTime - a.earliestRecordedTime).map(transaction => {
          if (seen.has(transaction.txhash)){
            return
          }
          seen.add(transaction.txhash);
          return (<TransactionLink key={transaction.txhash} tx={transaction} />);
        });
      }
    } else {
      noTxsOrLoading = (<div className="Waiting Waiting-Padded">Loading Transactions...</div>);
    }
    return txs ? txs : noTxsOrLoading;
  }

  render() {
    const node = this.state.node;
    if (!node) {
      return (<div className="Waiting Waiting-Padded">Couldn&apos;t locate node: {this.props.match.params.node}</div>);
    }

    return (
      <section className="BlockCard">
        <header>
          <button className="Button" onClick={this.props.history.goBack}>
            &larr; Back
          </button>
          <h1 className="Title">
            {node.name}
          </h1>
        </header>
        <main className="corda-details-container corda-node-details">
          <div className="corda-details-section">
            <h3 className="Label">Connection Details</h3>
            <div className="DataRow corda-node-details-ports corda-details-section corda-details-padded">
              <div>
                <div className="Label">RPC Port</div>
                <div className="Value">{node.rpcPort}</div>
              </div>
              <div>
                <div className="Label">P2P Port</div>
                <div className="Value">{node.p2pPort}</div>
              </div>
              <div>
                <div className="Label">Admin Port</div>
                <div className="Value">{node.adminPort}</div>
              </div>
              <div>
                <div className="Label">SSHD Port</div>
                <div className="Value">{node.sshdPort}</div>
              </div>
            </div>
            <div className="DataRow corda-node-details-ports corda-details-section corda-details-padded">
              <div>
                <div className="Label">Username</div>
                <div className="Value">user1</div>
              </div>
              <div>
                <div className="Label">Password</div>
                <div className="Value">letmein</div>
              </div>
            </div>
            <div className="DataRow corda-details-section corda-details-padded">
              <div>
                <div className="Label">Postgres Connection</div>
                <div className="Value">postgresql://corda@localhost:{this.props.config.settings.workspace.postgresPort}/{node.safeName}</div>
              </div>
            </div>
          </div>

          <div className="corda-details-section">
            <h3 className="Label">CorDapps</h3>
            <div className="Nodes DataRows">
              <main>{this.getCordapps()}</main>
            </div>
          </div>

          <div className="corda-details-section">
            <h3 className="Label">Connected Nodes &amp; Notaries</h3>
            <div className="Nodes DataRows">
              <main>{this.getConnectedNodes()}</main>
            </div>
          </div>

          <div className="corda-details-section">
            <h3 className="Label">Recent Transactions</h3>
            <div className="Nodes DataRows">
              <main>{this.getTransactions()}</main>
            </div>
          </div>
          <span>TODO-NICK: this doesn't even belong here in this UI component</span>
          <div ref={this.xtermRef}></div>
        </main>
      </section>
    );
  }
}

export default connect(
  NodeDetails,
  "config"
);
